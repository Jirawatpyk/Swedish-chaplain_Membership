/**
 * Unit tests for `resetPassword` use case (T100, spec US3 AS2-4,
 * FR-005, FR-008, T-11).
 *
 * 100% line + branch + function coverage target.
 * Mock pattern mirrors tests/unit/members/application/archive-member.test.ts.
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
import { asUserId, asTokenId, asPasswordHash } from '@/modules/auth/domain/branded';
import type { PasswordResetToken } from '@/modules/auth/domain/token';
import { checkPasswordPolicy, weakPasswordMetricBucket } from '@/modules/auth/application/password-policy';
import { authMetrics } from '@/lib/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-17T12:00:00Z');
const USER_ID = asUserId('user-rp-001');
const TOKEN_ID = asTokenId('token-reset-abc-123');
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
    lockedUntil: new Date(NOW.getTime() - 1000), // lock already expired
    displayName: 'Test Member',
    emailVerified: true,
    requiresPasswordReset: true, // this is why they are resetting
    ...overrides,
  };
}

// Import asEmailAddress here — it was used in makeUser above
import { asEmailAddress } from '@/modules/auth/domain/branded';

function makeToken(overrides: Partial<PasswordResetToken> = {}): PasswordResetToken {
  return {
    id: TOKEN_ID,
    userId: USER_ID,
    createdAt: new Date(NOW.getTime() - 10 * 60 * 1000), // 10 min ago
    expiresAt: new Date(NOW.getTime() + 50 * 60 * 1000), // 50 min from now → valid
    consumedAt: null,
    ...overrides,
  };
}

const BASE_INPUT = {
  token: TOKEN_ID,
  newPassword: 'BrandNewPass!789',
  sourceIp: '2.3.4.5',
  requestId: 'req-rp-001',
};

/** Build a fully-wired deps stub for reset-password, overridable per test. */
function makeDeps(overrides: Partial<ResetPasswordDeps> = {}): ResetPasswordDeps {
  return {
    users: {
      findById: vi.fn().mockResolvedValue(makeUser()),
      setPasswordHash: vi.fn().mockResolvedValue(undefined),
      clearLock: vi.fn().mockResolvedValue(undefined),
      clearFailedCount: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResetPasswordDeps['users'],
    tokens: {
      findResetById: vi.fn().mockResolvedValue(makeToken()),
      markResetConsumed: vi.fn().mockResolvedValue(undefined),
      invalidateAllUnconsumedForUser: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResetPasswordDeps['tokens'],
    sessions: {
      deleteByUserId: vi.fn().mockResolvedValue(0),
    } as unknown as ResetPasswordDeps['sessions'],
    audit: {
      append: vi.fn().mockResolvedValue(undefined),
    } as unknown as ResetPasswordDeps['audit'],
    hasher: {
      hash: vi.fn().mockResolvedValue(NEW_HASH),
    } as unknown as ResetPasswordDeps['hasher'],
    limiter: {
      check: vi.fn().mockResolvedValue({ success: true, reset: Date.now() + 900_000 }),
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
    // Default policy mock: pass every password through as valid.
    vi.mocked(checkPasswordPolicy).mockResolvedValue({ ok: true, errors: [], strength: 'strong' });
    vi.mocked(weakPasswordMetricBucket).mockReturnValue(null);
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  it('returns rate-limited when IP bucket is exhausted', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi.fn().mockResolvedValue({ success: false, reset: Date.now() + 15_000 }),
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
        check: vi.fn().mockResolvedValue({ success: false, reset: Date.now() - 2_000 }),
      } as unknown as ResetPasswordDeps['limiter'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'rate-limited') {
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });

  // ── Token not found ────────────────────────────────────────────────────────
  it('returns link-invalid with reason "not-found" when token does not exist', async () => {
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(null),
        markResetConsumed: vi.fn(),
        invalidateAllUnconsumedForUser: vi.fn(),
      } as unknown as ResetPasswordDeps['tokens'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('link-invalid');
      if (result.error.code === 'link-invalid') {
        expect(result.error.reason).toBe('not-found');
      }
    }
    // No audit event when token is missing (no target user to correlate)
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  // ── Token expired ──────────────────────────────────────────────────────────
  it('returns link-invalid with reason "expired" for an expired token', async () => {
    const expiredToken = makeToken({
      expiresAt: new Date(NOW.getTime() - 1), // expired exactly 1ms ago
      consumedAt: null,
    });
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(expiredToken),
        markResetConsumed: vi.fn(),
        invalidateAllUnconsumedForUser: vi.fn(),
      } as unknown as ResetPasswordDeps['tokens'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('link-invalid');
      if (result.error.code === 'link-invalid') {
        expect(result.error.reason).toBe('expired');
      }
    }
    // Audit event IS emitted for expired/consumed tokens (token has a userId)
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'password_reset_failed',
        targetUserId: USER_ID,
      }),
    );
  });

  // ── Token consumed (used) ──────────────────────────────────────────────────
  it('returns link-invalid with reason "used" for an already-consumed token', async () => {
    const consumedToken = makeToken({
      consumedAt: new Date(NOW.getTime() - 5 * 60 * 1000), // consumed 5 min ago
    });
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(consumedToken),
        markResetConsumed: vi.fn(),
        invalidateAllUnconsumedForUser: vi.fn(),
      } as unknown as ResetPasswordDeps['tokens'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('link-invalid');
      if (result.error.code === 'link-invalid') {
        expect(result.error.reason).toBe('used');
      }
    }
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'password_reset_failed' }),
    );
  });

  // ── User not found ─────────────────────────────────────────────────────────
  it('returns link-invalid with reason "used" when user does not exist', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(null),
        setPasswordHash: vi.fn(),
        clearLock: vi.fn(),
        clearFailedCount: vi.fn(),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('link-invalid');
      if (result.error.code === 'link-invalid') {
        expect(result.error.reason).toBe('used');
      }
    }
  });

  // ── User not active ────────────────────────────────────────────────────────
  it('returns link-invalid with reason "used" when user is disabled', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(makeUser({ status: 'disabled' })),
        setPasswordHash: vi.fn(),
        clearLock: vi.fn(),
        clearFailedCount: vi.fn(),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('link-invalid');
      if (result.error.code === 'link-invalid') {
        expect(result.error.reason).toBe('used');
      }
    }
  });

  it('returns link-invalid with reason "used" when user is pending', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(makeUser({ status: 'pending' })),
        setPasswordHash: vi.fn(),
        clearLock: vi.fn(),
        clearFailedCount: vi.fn(),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'link-invalid') {
      expect(result.error.reason).toBe('used');
    }
  });

  // ── Weak password ──────────────────────────────────────────────────────────
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
    if (!result.ok) {
      expect(result.error.code).toBe('weak-password');
      if (result.error.code === 'weak-password') {
        expect(result.error.errors).toEqual(policyErrors);
      }
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

  // ── Success: no active sessions ────────────────────────────────────────────
  it('succeeds with signInUrl and role, no concurrent_sessions_revoked when 0 sessions killed', async () => {
    const deps = makeDeps({
      sessions: {
        deleteByUserId: vi.fn().mockResolvedValue(0),
      } as unknown as ResetPasswordDeps['sessions'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.role).toBe('member');
      // member role → /portal/sign-in
      expect(result.value.signInUrl).toBe('/portal/sign-in');
    }

    const auditCalls = vi.mocked(deps.audit.append).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_reset_completed');
    expect(auditCalls).not.toContain('concurrent_sessions_revoked');

    expect(authMetrics.passwordResetCompleted).toHaveBeenCalledOnce();
    expect(authMetrics.passwordChanged).toHaveBeenCalledWith('reset');
  });

  // ── Success: sessions killed → fires concurrent_sessions_revoked ───────────
  it('emits concurrent_sessions_revoked when sessions were active at reset time', async () => {
    const deps = makeDeps({
      sessions: {
        deleteByUserId: vi.fn().mockResolvedValue(2), // 2 sessions killed
      } as unknown as ResetPasswordDeps['sessions'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);

    const auditCalls = vi.mocked(deps.audit.append).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_reset_completed');
    expect(auditCalls).toContain('concurrent_sessions_revoked');

    const revokedCall = vi.mocked(deps.audit.append).mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'concurrent_sessions_revoked',
    );
    expect((revokedCall?.[0] as { summary: string }).summary).toContain('2 session(s)');
  });

  // ── Correct wiring: consume-then-set ordering ─────────────────────────────
  it('calls markResetConsumed BEFORE setPasswordHash (W-01 ordering)', async () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      tokens: {
        findResetById: vi.fn().mockResolvedValue(makeToken()),
        markResetConsumed: vi.fn().mockImplementation(async () => {
          callOrder.push('markResetConsumed');
        }),
        invalidateAllUnconsumedForUser: vi.fn().mockImplementation(async () => {
          callOrder.push('invalidateAllUnconsumedForUser');
        }),
      } as unknown as ResetPasswordDeps['tokens'],
      users: {
        findById: vi.fn().mockResolvedValue(makeUser()),
        setPasswordHash: vi.fn().mockImplementation(async () => {
          callOrder.push('setPasswordHash');
        }),
        clearLock: vi.fn().mockResolvedValue(undefined),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
      } as unknown as ResetPasswordDeps['users'],
    });
    await resetPassword(BASE_INPUT, deps);
    expect(callOrder.indexOf('markResetConsumed')).toBeLessThan(
      callOrder.indexOf('setPasswordHash'),
    );
    expect(callOrder.indexOf('invalidateAllUnconsumedForUser')).toBeLessThan(
      callOrder.indexOf('setPasswordHash'),
    );
  });

  it('calls clearLock and clearFailedCount on success', async () => {
    const deps = makeDeps();
    await resetPassword(BASE_INPUT, deps);
    expect(deps.users.clearLock).toHaveBeenCalledWith(USER_ID);
    expect(deps.users.clearFailedCount).toHaveBeenCalledWith(USER_ID);
  });

  it('calls invalidateAllUnconsumedForUser with the correct userId', async () => {
    const deps = makeDeps();
    await resetPassword(BASE_INPUT, deps);
    expect(deps.tokens.invalidateAllUnconsumedForUser).toHaveBeenCalledWith(USER_ID, NOW);
  });

  // ── signInUrl mapping for staff roles ────────────────────────────────────
  it('returns /admin/sign-in as signInUrl for an admin user', async () => {
    const deps = makeDeps({
      users: {
        findById: vi.fn().mockResolvedValue(makeUser({ role: 'admin' })),
        setPasswordHash: vi.fn().mockResolvedValue(undefined),
        clearLock: vi.fn().mockResolvedValue(undefined),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
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
        setPasswordHash: vi.fn().mockResolvedValue(undefined),
        clearLock: vi.fn().mockResolvedValue(undefined),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
      } as unknown as ResetPasswordDeps['users'],
    });
    const result = await resetPassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.signInUrl).toBe('/admin/sign-in');
    }
  });
});
