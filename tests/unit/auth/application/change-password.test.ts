/**
 * Unit tests for `changePassword` use case (T151, spec US6 AS1-AS3,
 * contracts § 5).
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
// 125 — the success path runs in `db.transaction(...)`; the stub hands
// the callback a sentinel tx so the tests can assert every write got it.
const { TX } = vi.hoisted(() => ({ TX: { __tx: 'change-password' } }));
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(TX)),
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

import { changePassword } from '@/modules/auth/application/change-password';
import type { ChangePasswordDeps } from '@/modules/auth/application/change-password';
import type { UserAccount } from '@/modules/auth/domain/user';
import { asUserId, asEmailAddress, asPasswordHash, asSessionToken } from '@/modules/auth/domain/branded';
import type { Session } from '@/modules/auth/domain/session';
import { checkPasswordPolicy, weakPasswordMetricBucket } from '@/modules/auth/application/password-policy';
import { authMetrics } from '@/lib/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-17T12:00:00Z');
const USER_ID = asUserId('user-chpw-001');
const OLD_SESSION_ID = asSessionToken('old-sess-001');
const NEW_SESSION_ID = asSessionToken('new-sess-002');
const PASS_HASH = asPasswordHash('$argon2id$v=19$stored-hash');
const NEW_HASH = asPasswordHash('$argon2id$v=19$new-hash');
// 125 — two atomic buckets: the generous policy bucket (HIBP calls) and the
// strict guess bucket (argon2 verify of the current password).
const POLICY_KEY = `change-pw-policy:user:${USER_ID}`;
const GUESS_KEY = `change-pw:user:${USER_ID}`;

/** Keys the limiter was charged on, in call order. */
function checkedKeys(deps: ChangePasswordDeps): string[] {
  return vi.mocked(deps.limiter.check).mock.calls.map((c) => c[0]);
}

function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: USER_ID,
    email: asEmailAddress('staff@swecham.test'),
    role: 'admin',
    status: 'active',
    createdAt: NOW,
    lastSignInAt: null,
    lastPasswordChangedAt: null,
    failedSignInCount: 0,
    lockedUntil: null,
    displayName: 'Staff User',
    emailVerified: true,
    requiresPasswordReset: false,
    ...overrides,
  };
}

function makeNewSession(): Session {
  return {
    id: NEW_SESSION_ID,
    userId: USER_ID,
    createdAt: NOW,
    lastSeenAt: NOW,
    expiresAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    sourceIp: '10.0.0.1',
  };
}

const BASE_INPUT = {
  user: makeUser(),
  currentSessionId: OLD_SESSION_ID,
  currentPassword: 'OldPassword!123',
  newPassword: 'NewSecurePass!456',
  sourceIp: '10.0.0.1',
  requestId: 'req-chpw-001',
};

/** Build a fully-wired deps stub for change-password, overridable per test. */
function makeDeps(overrides: Partial<ChangePasswordDeps> = {}): ChangePasswordDeps {
  return {
    users: {
      findByEmail: vi.fn().mockResolvedValue({ user: makeUser(), passwordHash: PASS_HASH }),
      setPasswordHashInTx: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChangePasswordDeps['users'],
    sessions: {
      deleteByUserIdInTx: vi.fn().mockResolvedValue(1), // 1 session deleted (the current one)
      createInTx: vi.fn().mockResolvedValue(makeNewSession()),
    } as unknown as ChangePasswordDeps['sessions'],
    audit: {
      append: vi.fn().mockResolvedValue(undefined),
      appendInTx: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChangePasswordDeps['audit'],
    hasher: {
      verify: vi.fn().mockResolvedValue(true),
      hash: vi.fn().mockResolvedValue(NEW_HASH),
    } as unknown as ChangePasswordDeps['hasher'],
    limiter: {
      // 125 — an atomic check() is the gate; RateLimiter has no peek.
      check: vi
        .fn()
        .mockResolvedValue({ success: true, reset: Date.now() + 900_000 }),
    } as unknown as ChangePasswordDeps['limiter'],
    checkPolicy: checkPasswordPolicy,
    now: () => NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('changePassword use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default policy mock: pass every password through as valid.
    vi.mocked(checkPasswordPolicy).mockResolvedValue({ ok: true, errors: [], strength: 'strong' });
    vi.mocked(weakPasswordMetricBucket).mockReturnValue(null);
  });

  // ── Rate limiting (125 — atomic check before verify) ────────────────────
  it('returns rate-limited when the per-user guess bucket is exhausted', async () => {
    const deps = makeDeps({
      limiter: {
        // Only the guess bucket is exhausted; the policy bucket has room.
        check: vi.fn().mockImplementation(async (key: string) =>
          key === GUESS_KEY
            ? { success: false, reset: Date.now() + 10_000 }
            : { success: true, reset: Date.now() + 900_000 },
        ),
      } as unknown as ChangePasswordDeps['limiter'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate-limited');
      if (result.error.code === 'rate-limited') {
        expect(result.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    }
    // Blocked before argon2 runs.
    expect(deps.hasher.verify).not.toHaveBeenCalled();
  });

  it('uses minimum of 1 second for retryAfterSeconds when reset is in the past', async () => {
    const deps = makeDeps({
      limiter: {
        // Only the guess bucket is exhausted; the policy bucket has room.
        check: vi.fn().mockImplementation(async (key: string) =>
          key === GUESS_KEY
            ? { success: false, reset: Date.now() - 500 }
            : { success: true, reset: Date.now() + 900_000 },
        ),
      } as unknown as ChangePasswordDeps['limiter'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'rate-limited') {
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });

  // 125 — every attempt consumes the bucket BEFORE argon2 verify, so a
  // concurrent burst cannot all pass a non-consuming gate.
  it('charges the policy bucket, then the guess bucket, before verify on the happy path', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      limiter: {
        check: vi.fn().mockImplementation(async (key: string) => {
          order.push(`check:${key}`);
          return { success: true, reset: Date.now() + 900_000 };
        }),
      } as unknown as ChangePasswordDeps['limiter'],
      hasher: {
        verify: vi.fn().mockImplementation(async () => {
          order.push('verify');
          return true;
        }),
        hash: vi.fn().mockResolvedValue(NEW_HASH),
      } as unknown as ChangePasswordDeps['hasher'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(order).toEqual([`check:${POLICY_KEY}`, `check:${GUESS_KEY}`, 'verify']);
  });

  it('calls limiter.check() exactly once on the wrong-current branch', async () => {
    const deps = makeDeps({
      hasher: {
        verify: vi.fn().mockResolvedValue(false),
        hash: vi.fn().mockResolvedValue(NEW_HASH),
      } as unknown as ChangePasswordDeps['hasher'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong-current-password');
    expect(checkedKeys(deps).filter((k) => k === GUESS_KEY)).toHaveLength(1);
  });

  // ── User not found / no password hash ─────────────────────────────────────
  it('returns wrong-current-password when findByEmail returns null', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue(null),
      } as unknown as ChangePasswordDeps['users'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong-current-password');
  });

  it('returns wrong-current-password when passwordHash is null/falsy', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({ user: makeUser(), passwordHash: null }),
      } as unknown as ChangePasswordDeps['users'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong-current-password');
  });

  // ── Wrong current password ─────────────────────────────────────────────────
  it('returns wrong-current-password when current password verification fails', async () => {
    const deps = makeDeps({
      hasher: {
        verify: vi.fn().mockResolvedValue(false),
        hash: vi.fn(),
      } as unknown as ChangePasswordDeps['hasher'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('wrong-current-password');
  });

  // ── Same password (short-circuits before policy) ──────────────────────────
  it('returns same-password when newPassword equals currentPassword', async () => {
    const samePasswordInput = {
      ...BASE_INPUT,
      currentPassword: 'SamePassword!123',
      newPassword: 'SamePassword!123',
    };
    const deps = makeDeps();
    const result = await changePassword(samePasswordInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('same-password');
    // Policy should NOT be called (short-circuit before HIBP)
    expect(vi.mocked(checkPasswordPolicy)).not.toHaveBeenCalled();
    expect(authMetrics.passwordWeakRejected).toHaveBeenCalledWith('same');
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
    const result = await changePassword(BASE_INPUT, deps);
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
    await changePassword(BASE_INPUT, deps);
    expect(authMetrics.passwordWeakRejected).not.toHaveBeenCalled();
  });

  // ── Success: 0 extra sessions (just the current one) ──────────────────────
  it('succeeds and does NOT emit concurrent_sessions_revoked when only 1 session existed', async () => {
    // deleteByUserIdInTx returns 1 → killed = max(1-1, 0) = 0, no extra audit
    const deps = makeDeps({
      sessions: {
        deleteByUserIdInTx: vi.fn().mockResolvedValue(1),
        createInTx: vi.fn().mockResolvedValue(makeNewSession()),
      } as unknown as ChangePasswordDeps['sessions'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newSession.id).toBe(NEW_SESSION_ID);
    }
    const auditCalls = vi.mocked(deps.audit.appendInTx).mock.calls.map(
      (c) => (c[1] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_changed');
    expect(auditCalls).not.toContain('concurrent_sessions_revoked');
    expect(authMetrics.passwordChanged).toHaveBeenCalledWith('self');
  });

  // ── Success: multiple sessions → fires concurrent_sessions_revoked ─────────
  it('succeeds and emits concurrent_sessions_revoked when multiple sessions existed', async () => {
    // deleteByUserIdInTx returns 3 → killed = max(3-1, 0) = 2 (2 other devices)
    const deps = makeDeps({
      sessions: {
        deleteByUserIdInTx: vi.fn().mockResolvedValue(3),
        createInTx: vi.fn().mockResolvedValue(makeNewSession()),
      } as unknown as ChangePasswordDeps['sessions'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    const auditCalls = vi.mocked(deps.audit.appendInTx).mock.calls.map(
      (c) => (c[1] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_changed');
    expect(auditCalls).toContain('concurrent_sessions_revoked');

    // Verify the summary mentions the correct count
    const revokedCall = vi.mocked(deps.audit.appendInTx).mock.calls.find(
      (c) => (c[1] as { eventType: string }).eventType === 'concurrent_sessions_revoked',
    );
    expect((revokedCall?.[1] as { summary: string }).summary).toContain('2 session(s)');
    expect(authMetrics.passwordChanged).toHaveBeenCalledWith('self');
  });

  it('works when deleteByUserIdInTx returns 0 (edge case)', async () => {
    // 0 sessions deleted → killed = max(0-1, 0) = 0
    const deps = makeDeps({
      sessions: {
        deleteByUserIdInTx: vi.fn().mockResolvedValue(0),
        createInTx: vi.fn().mockResolvedValue(makeNewSession()),
      } as unknown as ChangePasswordDeps['sessions'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    const auditCalls = vi.mocked(deps.audit.appendInTx).mock.calls.map(
      (c) => (c[1] as { eventType: string }).eventType,
    );
    expect(auditCalls).not.toContain('concurrent_sessions_revoked');
  });

  // ── N1 (Round 3): MalformedHashError branch ─────────────────────────────
  // When the stored hash is corrupted, change-password MUST:
  //   1. Consume exactly the one gate check() every attempt pays (125);
  //      no second debit for the malformed hash
  //   2. Emit `password_malformed_hash_detected` audit (operator signal)
  //   3. Return `wrong-current-password` (UX consistent with sign-in's
  //      invalid-credentials — user can use /forgot-password to fix)
  // Pre-F3 the throw bubbled to the route's B3 catch → opaque 500 +
  // zero audit trail.
  it('MalformedHashError: skips lockout + emits dedicated audit + returns wrong-current', async () => {
    const { MalformedHashError } = await import(
      '@/modules/auth/infrastructure/password/argon2-hasher'
    );
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const checkSpy = vi.fn().mockResolvedValue({
      success: true,
      reset: Date.now() + 900_000,
    });
    const deps = makeDeps({
      hasher: {
        verify: vi.fn().mockRejectedValue(
          new MalformedHashError(new Error('argon2: invalid encoded hash')),
        ),
        hash: vi.fn(),
      } as unknown as ChangePasswordDeps['hasher'],
      audit: { append: auditSpy } as unknown as ChangePasswordDeps['audit'],
      limiter: {
        check: checkSpy,
      } as unknown as ChangePasswordDeps['limiter'],
    });

    const result = await changePassword(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('wrong-current-password');

    // The gate check() ran once; no extra debit.
    expect(checkSpy.mock.calls.filter((c) => c[0] === GUESS_KEY)).toHaveLength(1);

    // Dedicated audit event emitted
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'password_malformed_hash_detected',
        actorUserId: USER_ID,
        targetUserId: USER_ID,
        // S2 (Round 4) — pin parity with the O6 sign-in test:
        // operators that alert on `summary LIKE '%malformed%'`
        // expect the substring to appear here too.
        summary: expect.stringContaining('malformed'),
      }),
    );
  });

  it('MalformedHashError: re-throws non-malformed verify errors', async () => {
    const deps = makeDeps({
      hasher: {
        verify: vi
          .fn()
          .mockRejectedValue(new Error('argon2: native module crashed')),
        hash: vi.fn(),
      } as unknown as ChangePasswordDeps['hasher'],
    });

    await expect(changePassword(BASE_INPUT, deps)).rejects.toThrow(
      'argon2: native module crashed',
    );
  });

  // ── Correct wiring of calls ────────────────────────────────────────────────
  it('calls setPasswordHashInTx with the tx, the new hash and now timestamp', async () => {
    const deps = makeDeps();
    await changePassword(BASE_INPUT, deps);
    expect(deps.users.setPasswordHashInTx).toHaveBeenCalledWith(TX, USER_ID, NEW_HASH, NOW);
  });

  it('creates a new session in the same tx with the correct userId and sourceIp', async () => {
    const deps = makeDeps();
    await changePassword(BASE_INPUT, deps);
    expect(deps.sessions.createInTx).toHaveBeenCalledWith(TX, {
      userId: USER_ID,
      sourceIp: BASE_INPUT.sourceIp,
      now: NOW,
    });
  });

  // 125 — password write, session revoke, new session and audit commit
  // together: a failure in any step must surface (and roll back), never
  // leave the password changed with the old sessions alive.
  it('runs every success-path write inside one db.transaction and propagates a failure', async () => {
    const { db } = await import('@/lib/db');
    const deps = makeDeps({
      sessions: {
        deleteByUserIdInTx: vi.fn().mockRejectedValue(new Error('neon: connection dropped')),
        createInTx: vi.fn(),
      } as unknown as ChangePasswordDeps['sessions'],
    });
    await expect(changePassword(BASE_INPUT, deps)).rejects.toThrow('neon: connection dropped');
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(deps.users.setPasswordHashInTx).toHaveBeenCalledWith(TX, USER_ID, NEW_HASH, NOW);
    expect(deps.sessions.createInTx).not.toHaveBeenCalled();
    expect(deps.audit.appendInTx).not.toHaveBeenCalled();
  });

  // 125 (round 2) — a rejected NEW password (same / weak) is not a guess of
  // the current one, so it must not spend the brute-force budget.
  it('does not debit the limiter when the new password equals the current one', async () => {
    const deps = makeDeps();
    const result = await changePassword(
      { ...BASE_INPUT, currentPassword: 'SamePassword!123', newPassword: 'SamePassword!123' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('same-password');
    expect(checkedKeys(deps)).not.toContain(GUESS_KEY);
    expect(deps.hasher.verify).not.toHaveBeenCalled();
  });

  it('does not debit the limiter when the policy rejects the new password', async () => {
    vi.mocked(checkPasswordPolicy).mockResolvedValue({
      ok: false,
      errors: [{ code: 'too-short' as const, minLength: 12 }],
      strength: 'weak',
    });
    const deps = makeDeps();
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('weak-password');
    expect(checkedKeys(deps)).not.toContain(GUESS_KEY);
    expect(deps.hasher.verify).not.toHaveBeenCalled();
  });

  // 125 (security-engineer N1) — the policy steps make an outbound HIBP call,
  // so they sit behind their own, more generous atomic bucket: a session
  // holder cannot drive unlimited HIBP traffic (which fails open, T-11).
  it('charges the policy bucket before the HIBP-backed policy check', async () => {
    const order: string[] = [];
    vi.mocked(checkPasswordPolicy).mockImplementation(async () => {
      order.push('policy');
      return { ok: true, errors: [], strength: 'strong' };
    });
    const deps = makeDeps({
      limiter: {
        check: vi.fn().mockImplementation(async (key: string) => {
          order.push(`check:${key}`);
          return { success: true, reset: Date.now() + 900_000 };
        }),
      } as unknown as ChangePasswordDeps['limiter'],
    });
    await changePassword(BASE_INPUT, deps);
    expect(order.slice(0, 2)).toEqual([`check:${POLICY_KEY}`, 'policy']);
    expect(deps.limiter.check).toHaveBeenCalledWith(POLICY_KEY, 30, 15 * 60);
  });

  it('returns rate-limited without calling the policy when the policy bucket is exhausted', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi.fn().mockImplementation(async (key: string) =>
          key === POLICY_KEY
            ? { success: false, reset: Date.now() + 60_000 }
            : { success: true, reset: Date.now() + 900_000 },
        ),
      } as unknown as ChangePasswordDeps['limiter'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate-limited');
      // Retry-After comes from the POLICY bucket's reset (~60 s), not the
      // guess bucket's (~900 s).
      if (result.error.code === 'rate-limited') {
        expect(result.error.retryAfterSeconds).toBeGreaterThanOrEqual(59);
        expect(result.error.retryAfterSeconds).toBeLessThanOrEqual(60);
      }
    }
    expect(vi.mocked(checkPasswordPolicy)).not.toHaveBeenCalled();
    expect(checkedKeys(deps)).not.toContain(GUESS_KEY);
    expect(deps.hasher.verify).not.toHaveBeenCalled();
  });
});
