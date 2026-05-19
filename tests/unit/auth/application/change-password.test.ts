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
      setPasswordHash: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChangePasswordDeps['users'],
    sessions: {
      deleteByUserId: vi.fn().mockResolvedValue(1), // 1 session deleted (the current one)
      create: vi.fn().mockResolvedValue(makeNewSession()),
    } as unknown as ChangePasswordDeps['sessions'],
    audit: {
      append: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChangePasswordDeps['audit'],
    hasher: {
      verify: vi.fn().mockResolvedValue(true),
      hash: vi.fn().mockResolvedValue(NEW_HASH),
    } as unknown as ChangePasswordDeps['hasher'],
    limiter: {
      // B2 — peek default success; check default success (only invoked
      // on wrong-current branch).
      peek: vi
        .fn()
        .mockResolvedValue({ success: true, reset: Date.now() + 900_000 }),
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

  // ── Rate limiting (B2 — peek-then-consume) ──────────────────────────────
  it('returns rate-limited when the per-user limiter peek is exhausted', async () => {
    const deps = makeDeps({
      limiter: {
        peek: vi
          .fn()
          .mockResolvedValue({ success: false, reset: Date.now() + 10_000 }),
        check: vi.fn(),
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
    // peek-only — check() (the consuming op) must NOT fire when peek
    // already rejected.
    expect(deps.limiter.check).not.toHaveBeenCalled();
  });

  it('uses minimum of 1 second for retryAfterSeconds when reset is in the past', async () => {
    const deps = makeDeps({
      limiter: {
        peek: vi
          .fn()
          .mockResolvedValue({ success: false, reset: Date.now() - 500 }),
        check: vi.fn(),
      } as unknown as ChangePasswordDeps['limiter'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'rate-limited') {
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });

  // B2 — success path must NOT consume the rate-limit bucket.
  it('does NOT call limiter.check() on the happy path (success leaves bucket untouched)', async () => {
    const deps = makeDeps();
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    expect(deps.limiter.peek).toHaveBeenCalledTimes(1);
    expect(deps.limiter.check).not.toHaveBeenCalled();
  });

  // B2 — wrong-current consumes the rate-limit bucket.
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
    expect(deps.limiter.peek).toHaveBeenCalledTimes(1);
    expect(deps.limiter.check).toHaveBeenCalledTimes(1);
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
    // deleteByUserId returns 1 → killed = max(1-1, 0) = 0, no extra audit
    const deps = makeDeps({
      sessions: {
        deleteByUserId: vi.fn().mockResolvedValue(1),
        create: vi.fn().mockResolvedValue(makeNewSession()),
      } as unknown as ChangePasswordDeps['sessions'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newSession.id).toBe(NEW_SESSION_ID);
    }
    const auditCalls = vi.mocked(deps.audit.append).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_changed');
    expect(auditCalls).not.toContain('concurrent_sessions_revoked');
    expect(authMetrics.passwordChanged).toHaveBeenCalledWith('self');
  });

  // ── Success: multiple sessions → fires concurrent_sessions_revoked ─────────
  it('succeeds and emits concurrent_sessions_revoked when multiple sessions existed', async () => {
    // deleteByUserId returns 3 → killed = max(3-1, 0) = 2 (2 other devices)
    const deps = makeDeps({
      sessions: {
        deleteByUserId: vi.fn().mockResolvedValue(3),
        create: vi.fn().mockResolvedValue(makeNewSession()),
      } as unknown as ChangePasswordDeps['sessions'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    const auditCalls = vi.mocked(deps.audit.append).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(auditCalls).toContain('password_changed');
    expect(auditCalls).toContain('concurrent_sessions_revoked');

    // Verify the summary mentions the correct count
    const revokedCall = vi.mocked(deps.audit.append).mock.calls.find(
      (c) => (c[0] as { eventType: string }).eventType === 'concurrent_sessions_revoked',
    );
    expect((revokedCall?.[0] as { summary: string }).summary).toContain('2 session(s)');
    expect(authMetrics.passwordChanged).toHaveBeenCalledWith('self');
  });

  it('works when deleteByUserId returns 0 (edge case)', async () => {
    // 0 sessions deleted → killed = max(0-1, 0) = 0
    const deps = makeDeps({
      sessions: {
        deleteByUserId: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue(makeNewSession()),
      } as unknown as ChangePasswordDeps['sessions'],
    });
    const result = await changePassword(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    const auditCalls = vi.mocked(deps.audit.append).mock.calls.map(
      (c) => (c[0] as { eventType: string }).eventType,
    );
    expect(auditCalls).not.toContain('concurrent_sessions_revoked');
  });

  // ── N1 (Round 3): MalformedHashError branch ─────────────────────────────
  // When the stored hash is corrupted, change-password MUST:
  //   1. NOT consume the rate-limit bucket (peek already passed; this
  //      is not a wrong-current event)
  //   2. NOT increment any failed-count (change-password has no
  //      failed-count, but limiter.check is the equivalent)
  //   3. Emit `password_malformed_hash_detected` audit (operator signal)
  //   4. Return `wrong-current-password` (UX consistent with sign-in's
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
    const peekSpy = vi.fn().mockResolvedValue({
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
        peek: peekSpy,
        check: checkSpy,
      } as unknown as ChangePasswordDeps['limiter'],
    });

    const result = await changePassword(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('wrong-current-password');

    // peek ran (gate), check did NOT (bucket only debits on real
    // wrong-current, not on DB-corruption malformed-hash)
    expect(peekSpy).toHaveBeenCalledTimes(1);
    expect(checkSpy).not.toHaveBeenCalled();

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
  it('calls setPasswordHash with the new hash and now timestamp', async () => {
    const deps = makeDeps();
    await changePassword(BASE_INPUT, deps);
    expect(deps.users.setPasswordHash).toHaveBeenCalledWith(USER_ID, NEW_HASH, NOW);
  });

  it('creates a new session with the correct userId and sourceIp', async () => {
    const deps = makeDeps();
    await changePassword(BASE_INPUT, deps);
    expect(deps.sessions.create).toHaveBeenCalledWith({
      userId: USER_ID,
      sourceIp: BASE_INPUT.sourceIp,
      now: NOW,
    });
  });
});
