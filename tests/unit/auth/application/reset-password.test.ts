/**
 * Unit tests for `resetPassword` use case (T100, spec US3 AS2-4,
 * FR-005, FR-008, T-11).
 *
 * A4 (post-ship 2026-05-17): the success path now runs inside
 * `db.transaction(...)` so we mock `@/lib/db` with a stub that invokes
 * the callback with a fake tx object and re-throws on abort.
 * Application-layer mutations call `*InTx` repo variants; the failure
 * paths (token-not-found / expired / consumed / user-not-active /
 * weak-password / rate-limited) all short-circuit BEFORE the tx is
 * opened and use the non-tx `audit.append`.
 *
 * 100% line + branch + function coverage target.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({ hashId: vi.fn((s: string) => s) }));
vi.mock('@/lib/metrics', () => ({
  authMetrics: {
    signInAttempt: vi.fn(),
    signInDuration: vi.fn(),
    lockout: vi.fn(),
    passwordWeakRejected: vi.fn(),
    passwordChanged: vi.fn(),
    passwordResetCompleted: vi.fn(),
    auditMissing: vi.fn(),
  },
}));
// A4 — `db.transaction(fn)` stub: invokes fn with a fake tx and
// re-throws (mirrors Drizzle's commit-on-return / rollback-on-throw
// semantics).
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({} as never)),
  },
}));
vi.mock('@/lib/auth-deps', () => ({
  defaultSignInDeps: {},
  defaultChangePasswordDeps: {},
  defaultResetPasswordDeps: {},
}));
vi.mock('@/modules/auth/application/password-policy', () => ({
  checkPasswordPolicy: vi.fn(),
  weakPasswordMetricBucket: vi.fn(),
}));

import { resetPassword } from '@/modules/auth/application/reset-password';
import type { ResetPasswordDeps } from '@/modules/auth/application/reset-password';
import type { UserAccount } from '@/modules/auth/domain/user';
import {
  asUserId,
  asResetTokenId,
  asTokenId,
  asPasswordHash,
  asEmailAddress,
} from '@/modules/auth/domain/branded';
import type { PasswordResetToken } from '@/modules/auth/domain/token';
import {
  checkPasswordPolicy,
  weakPasswordMetricBucket,
} from '@/modules/auth/application/password-policy';
import { authMetrics } from '@/lib/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-17T12:00:00Z');
const USER_ID = asUserId('user-rp-001');
const TOKEN_ID = asTokenId('token-reset-abc-123');
const PLAINTEXT_TOKEN = asResetTokenId('token-reset-abc-123');
const NEW_HASH = asPasswordHash('$argon2id$v=19$new-hash-for-reset');

function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: USER_ID,
    email: asEmailAddress('member@swecham.test'),
    role: 'member',
    status: 'active',
    createdAt: NOW,
    lastSignInAt: null,
    lastPasswordChangedAt: null,
    failedSignInCount: 3,
    lockedUntil: new Date(NOW.getTime() - 1000),
    displayName: 'Test Member',
    emailVerified: true,
    requiresPasswordReset: true,
    ...overrides,
  };
}

function makeToken(
  overrides: Partial<PasswordResetToken> = {},
): PasswordResetToken {
  return {
    id: TOKEN_ID,
    userId: USER_ID,
    createdAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    expiresAt: new Date(NOW.getTime() + 50 * 60 * 1000),
    consumedAt: null,
    ...overrides,
  };
}

const BASE_INPUT = {
  // E1 — input.token is plaintext (ResetTokenId); repo hashes
  // internally. Use cases only see the plaintext brand.
  token: PLAINTEXT_TOKEN,
  newPassword: 'BrandNewPass!789',
  sourceIp: '2.3.4.5',
  requestId: 'req-rp-001',
};

/** Build a fully-wired deps stub for reset-password — A4-aware. */
function makeDeps(
  overrides: Partial<ResetPasswordDeps> = {},
): ResetPasswordDeps {
  return {
    users: {
      findById: vi.fn().mockResolvedValue(makeUser()),
      // *InTx variants used inside the tx
      setPasswordHashInTx: vi.fn().mockResolvedValue(undefined),
      clearLockInTx: vi.fn().mockResolvedValue(undefined),
      clearFailedCountInTx: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResetPasswordDeps['users'],
    tokens: {
      findResetById: vi.fn().mockResolvedValue(makeToken()),
      markResetConsumedInTx: vi.fn().mockResolvedValue(undefined),
      invalidateAllUnconsumedForUserInTx: vi.fn().mockResolvedValue(0),
    } as unknown as ResetPasswordDeps['tokens'],
    sessions: {
      deleteByUserIdInTx: vi.fn().mockResolvedValue(0),
    } as unknown as ResetPasswordDeps['sessions'],
    audit: {
      // Pre-tx failure paths use append; in-tx success paths use appendInTx.
      append: vi.fn().mockResolvedValue(undefined),
      appendInTx: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResetPasswordDeps['audit'],
    hasher: {
      hash: vi.fn().mockResolvedValue(NEW_HASH),
    } as unknown as ResetPasswordDeps['hasher'],
    limiter: {
      check: vi
        .fn()
        .mockResolvedValue({ success: true, reset: Date.now() + 900_000 }),
    } as unknown as ResetPasswordDeps['limiter'],
    checkPolicy: checkPasswordPolicy,
    now: () => NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resetPassword use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkPasswordPolicy).mockResolvedValue({
      ok: true,
      errors: [],
      strength: 'strong',
    });
    vi.mocked(weakPasswordMetricBucket).mockReturnValue(null);
  });

  // ── Rate limiting ────────────────────────────────────────────────────────
  it('returns rate-limited when IP bucket is exhausted', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi
          .fn()
          .mockResolvedValue({ success: false, reset: Date.now() + 15_000 }),
      } as unknown as ResetPasswordDeps['limiter'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate-limited');
      if (result.error.code === 'rate-limited') {
        expect(result.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('uses minimum of 1 second for retryAfterSeconds when reset is past', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi
          .fn()
          .mockResolvedValue({ success: false, reset: Date.now() - 2_000 }),
      } as unknown as ResetPasswordDeps['limiter'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'rate-limited') {
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });

  // ── Token not found ──────────────────────────────────────────────────────
  it('returns link-invalid with reason "not-found" when token does not exist', async () => {
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(null),
        markResetConsumedInTx: vi.fn(),
        invalidateAllUnconsumedForUserInTx: vi.fn(),
      } as unknown as ResetPasswordDeps['tokens'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'link-invalid') {
      expect(result.error.reason).toBe('not-found');
    }
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  // ── Token expired ────────────────────────────────────────────────────────
  it('returns link-invalid with reason "expired" for an expired token', async () => {
    const expiredToken = makeToken({
      expiresAt: new Date(NOW.getTime() - 1),
      consumedAt: null,
    });
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(expiredToken),
        markResetConsumedInTx: vi.fn(),
        invalidateAllUnconsumedForUserInTx: vi.fn(),
      } as unknown as ResetPasswordDeps['tokens'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'link-invalid') {
      expect(result.error.reason).toBe('expired');
    }
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'password_reset_failed',
        targetUserId: USER_ID,
      }),
    );
  });

  // ── Token consumed ───────────────────────────────────────────────────────
  it('returns link-invalid with reason "used" for an already-consumed token', async () => {
    const consumedToken = makeToken({
      consumedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    });
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(consumedToken),
        markResetConsumedInTx: vi.fn(),
        invalidateAllUnconsumedForUserInTx: vi.fn(),
      } as unknown as ResetPasswordDeps['tokens'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'link-invalid') {
      expect(result.error.reason).toBe('used');
    }
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'password_reset_failed' }),
    );
  });

  // ── User not found ───────────────────────────────────────────────────────
  it('returns link-invalid with reason "used" when user does not exist', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(null),
        setPasswordHashInTx: vi.fn(),
        clearLockInTx: vi.fn(),
        clearFailedCountInTx: vi.fn(),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'link-invalid') {
      expect(result.error.reason).toBe('used');
    }
  });

  it('returns link-invalid with reason "used" when user is disabled', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(makeUser({ status: 'disabled' })),
        setPasswordHashInTx: vi.fn(),
        clearLockInTx: vi.fn(),
        clearFailedCountInTx: vi.fn(),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'link-invalid') {
      expect(result.error.reason).toBe('used');
    }
  });

  it('returns link-invalid with reason "used" when user is pending', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(makeUser({ status: 'pending' })),
        setPasswordHashInTx: vi.fn(),
        clearLockInTx: vi.fn(),
        clearFailedCountInTx: vi.fn(),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'link-invalid') {
      expect(result.error.reason).toBe('used');
    }
  });

  // ── Weak password ────────────────────────────────────────────────────────
  it('returns weak-password when policy rejects the new password', async () => {
    const policyErrors = [{ code: 'too-short' as const, minLength: 12 }];
    vi.mocked(checkPasswordPolicy).mockResolvedValue({
      ok: false,
      errors: policyErrors,
      strength: 'weak',
    });
    vi.mocked(weakPasswordMetricBucket).mockReturnValue('short');

    const deps = makeDeps();
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'weak-password') {
      expect(result.error.errors).toEqual(policyErrors);
    }
    expect(authMetrics.passwordWeakRejected).toHaveBeenCalledWith('short');
  });

  it('skips metric increment when weakPasswordMetricBucket returns null', async () => {
    const policyErrors = [{ code: 'too-short' as const, minLength: 12 }];
    vi.mocked(checkPasswordPolicy).mockResolvedValue({
      ok: false,
      errors: policyErrors,
      strength: 'weak',
    });
    vi.mocked(weakPasswordMetricBucket).mockReturnValue(null);

    const deps = makeDeps();
    await resetPassword(BASE_INPUT, deps);
    expect(authMetrics.passwordWeakRejected).not.toHaveBeenCalled();
  });

  // ── Success: no active sessions ──────────────────────────────────────────
  it('succeeds with signInUrl and role, no concurrent_sessions_revoked when 0 sessions killed', async () => {
    const deps = makeDeps({
      sessions: {
        deleteByUserIdInTx: vi.fn().mockResolvedValue(0),
      } as unknown as ResetPasswordDeps['sessions'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.role).toBe('member');
      expect(result.value.signInUrl).toBe('/portal/sign-in');
    }

    const auditCalls = vi.mocked(deps.audit.appendInTx).mock.calls.map(
      (c) => (c[1] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_reset_completed');
    expect(auditCalls).not.toContain('concurrent_sessions_revoked');

    expect(authMetrics.passwordResetCompleted).toHaveBeenCalledOnce();
    expect(authMetrics.passwordChanged).toHaveBeenCalledWith('reset');
  });

  // ── Success: sessions killed → fires concurrent_sessions_revoked ─────────
  it('emits concurrent_sessions_revoked when sessions were active at reset time', async () => {
    const deps = makeDeps({
      sessions: {
        deleteByUserIdInTx: vi.fn().mockResolvedValue(2),
      } as unknown as ResetPasswordDeps['sessions'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);

    const auditCalls = vi.mocked(deps.audit.appendInTx).mock.calls.map(
      (c) => (c[1] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_reset_completed');
    expect(auditCalls).toContain('concurrent_sessions_revoked');

    const revokedCall = vi.mocked(deps.audit.appendInTx).mock.calls.find(
      (c) =>
        (c[1] as { eventType: string }).eventType ===
        'concurrent_sessions_revoked',
    );
    expect((revokedCall?.[1] as { summary: string }).summary).toContain(
      '2 session(s)',
    );
  });

  // ── Correct wiring: consume-then-set ordering ────────────────────────────
  it('calls markResetConsumedInTx BEFORE setPasswordHashInTx (W-01 ordering preserved under A4)', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(makeToken()),
        markResetConsumedInTx: vi.fn().mockImplementation(async () => {
          callOrder.push('markResetConsumedInTx');
        }),
        invalidateAllUnconsumedForUserInTx: vi
          .fn()
          .mockImplementation(async () => {
            callOrder.push('invalidateAllUnconsumedForUserInTx');
            return 0;
          }),
      } as unknown as ResetPasswordDeps['tokens'],
      users: {
        findById: vi.fn().mockResolvedValue(makeUser()),
        setPasswordHashInTx: vi.fn().mockImplementation(async () => {
          callOrder.push('setPasswordHashInTx');
        }),
        clearLockInTx: vi.fn().mockResolvedValue(undefined),
        clearFailedCountInTx: vi.fn().mockResolvedValue(undefined),
      } as unknown as ResetPasswordDeps['users'],
    });
    await resetPassword(BASE_INPUT, deps);
    expect(callOrder.indexOf('markResetConsumedInTx')).toBeLessThan(
      callOrder.indexOf('setPasswordHashInTx'),
    );
    expect(callOrder.indexOf('invalidateAllUnconsumedForUserInTx')).toBeLessThan(
      callOrder.indexOf('setPasswordHashInTx'),
    );
  });

  it('calls clearLockInTx and clearFailedCountInTx on success', async () => {
    const deps = makeDeps();
    await resetPassword(BASE_INPUT, deps);
    expect(deps.users.clearLockInTx).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
    );
    expect(deps.users.clearFailedCountInTx).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
    );
  });

  it('calls invalidateAllUnconsumedForUserInTx with the correct userId', async () => {
    const deps = makeDeps();
    await resetPassword(BASE_INPUT, deps);
    expect(deps.tokens.invalidateAllUnconsumedForUserInTx).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      NOW,
    );
  });

  // ── signInUrl mapping for staff roles ────────────────────────────────────
  it('returns /admin/sign-in as signInUrl for an admin user', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(makeUser({ role: 'admin' })),
        setPasswordHashInTx: vi.fn().mockResolvedValue(undefined),
        clearLockInTx: vi.fn().mockResolvedValue(undefined),
        clearFailedCountInTx: vi.fn().mockResolvedValue(undefined),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signInUrl).toBe('/admin/sign-in');
      expect(result.value.role).toBe('admin');
    }
  });

  it('returns /admin/sign-in as signInUrl for a manager user', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(makeUser({ role: 'manager' })),
        setPasswordHashInTx: vi.fn().mockResolvedValue(undefined),
        clearLockInTx: vi.fn().mockResolvedValue(undefined),
        clearFailedCountInTx: vi.fn().mockResolvedValue(undefined),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signInUrl).toBe('/admin/sign-in');
    }
  });
});
