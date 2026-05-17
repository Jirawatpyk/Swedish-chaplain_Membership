/**
 * Unit tests for `signIn` use case (T068, spec FR-005 / FR-013 / FR-016,
 * security.md T-01 / T-02 / T-03 / T-06).
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

import { signIn, expectedPortal } from '@/modules/auth/application/sign-in';
import type { SignInDeps } from '@/modules/auth/application/sign-in';
import type { UserAccount } from '@/modules/auth/domain/user';
import { asUserId, asEmailAddress, asPasswordHash, asSessionId } from '@/modules/auth/domain/branded';
import type { Session } from '@/modules/auth/domain/session';
import { authMetrics } from '@/lib/metrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-04-17T12:00:00Z');
const USER_ID = asUserId('user-abc-123');
const SESSION_ID = asSessionId('sess-xyz-456');

function makeUser(overrides: Partial<UserAccount> = {}): UserAccount {
  return {
    id: USER_ID,
    email: asEmailAddress('admin@swecham.test'),
    role: 'admin',
    status: 'active',
    createdAt: NOW,
    lastSignInAt: null,
    lastPasswordChangedAt: null,
    failedSignInCount: 0,
    lockedUntil: null,
    displayName: 'Test Admin',
    emailVerified: true,
    requiresPasswordReset: false,
    ...overrides,
  };
}

function makeSession(): Session {
  return {
    id: SESSION_ID,
    userId: USER_ID,
    createdAt: NOW,
    lastSeenAt: NOW,
    expiresAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000),
    sourceIp: '127.0.0.1',
  };
}

const PASS_HASH = asPasswordHash('$argon2id$v=19$test-hash');

/** Build a fully-wired deps stub, overridable per test. */
function makeDeps(overrides: Partial<SignInDeps> = {}): SignInDeps {
  return {
    users: {
      findByEmail: vi.fn().mockResolvedValue({ user: makeUser(), passwordHash: PASS_HASH }),
      incrementFailedCount: vi.fn().mockResolvedValue(1),
      setLocked: vi.fn().mockResolvedValue(undefined),
      clearFailedCount: vi.fn().mockResolvedValue(undefined),
      updateLastSignIn: vi.fn().mockResolvedValue(undefined),
      // Provide no-op stubs for any other UserRepo methods the type may require
    } as unknown as SignInDeps['users'],
    sessions: {
      create: vi.fn().mockResolvedValue(makeSession()),
    } as unknown as SignInDeps['sessions'],
    audit: {
      append: vi.fn().mockResolvedValue(undefined),
    } as unknown as SignInDeps['audit'],
    hasher: {
      verify: vi.fn().mockResolvedValue(true),
      verifyDummy: vi.fn().mockResolvedValue(undefined),
    } as unknown as SignInDeps['hasher'],
    limiter: {
      check: vi.fn().mockResolvedValue({ success: true, reset: Date.now() + 900_000 }),
    } as unknown as SignInDeps['limiter'],
    now: () => NOW,
    ...overrides,
  };
}

const BASE_INPUT = {
  email: 'admin@swecham.test',
  password: 'SuperSecret!1234',
  portal: 'staff' as const,
  sourceIp: '1.2.3.4',
  requestId: 'req-001',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('signIn use case', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Malformed email ────────────────────────────────────────────────────────
  it('returns invalid-credentials for a malformed email (no @)', async () => {
    const deps = makeDeps();
    const result = await signIn({ ...BASE_INPUT, email: 'not-an-email' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    // No limiter call because the email fails parsing before rate check
    expect(deps.limiter.check).not.toHaveBeenCalled();
  });

  it('returns invalid-credentials for empty string email', async () => {
    const deps = makeDeps();
    const result = await signIn({ ...BASE_INPUT, email: '' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
  });

  // ── Rate limiting ──────────────────────────────────────────────────────────
  it('returns rate-limited when the email bucket is exhausted', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi.fn()
          .mockResolvedValueOnce({ success: false, reset: Date.now() + 5_000 })
          .mockResolvedValueOnce({ success: true, reset: Date.now() + 5_000 }),
      } as unknown as SignInDeps['limiter'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('rate-limited');
      if (result.error.code === 'rate-limited') {
        expect(result.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('returns rate-limited when the IP bucket is exhausted', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi.fn()
          .mockResolvedValueOnce({ success: true, reset: Date.now() + 5_000 })
          .mockResolvedValueOnce({ success: false, reset: Date.now() + 5_000 }),
      } as unknown as SignInDeps['limiter'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('rate-limited');
  });

  it('uses Math.max across both reset timestamps for retryAfterSeconds', async () => {
    const emailReset = Date.now() + 10_000;
    const ipReset = Date.now() + 60_000; // IP reset is further in the future
    const deps = makeDeps({
      limiter: {
        check: vi.fn()
          .mockResolvedValueOnce({ success: false, reset: emailReset })
          .mockResolvedValueOnce({ success: false, reset: ipReset }),
      } as unknown as SignInDeps['limiter'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'rate-limited') {
      expect(result.error.retryAfterSeconds).toBeGreaterThanOrEqual(
        Math.ceil((ipReset - Date.now()) / 1000) - 1,
      );
    }
  });

  it('uses minimum of 1 second for retryAfterSeconds when reset is in the past', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi.fn()
          .mockResolvedValueOnce({ success: false, reset: Date.now() - 1_000 })
          .mockResolvedValueOnce({ success: false, reset: Date.now() - 1_000 }),
      } as unknown as SignInDeps['limiter'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'rate-limited') {
      expect(result.error.retryAfterSeconds).toBe(1);
    }
  });

  // ── Unknown email (timing safety) ─────────────────────────────────────────
  it('calls verifyDummy and returns invalid-credentials for unknown email', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue(null),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.hasher.verifyDummy).toHaveBeenCalledOnce();
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sign_in_failure', actorUserId: 'anonymous' }),
    );
  });

  // ── Disabled user ──────────────────────────────────────────────────────────
  it('returns account-disabled for a disabled user', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ status: 'disabled' }),
          passwordHash: PASS_HASH,
        }),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('account-disabled');
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sign_in_failure' }),
    );
  });

  // ── Pending user ───────────────────────────────────────────────────────────
  it('calls verifyDummy and returns invalid-credentials for a pending user', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ status: 'pending' }),
          passwordHash: PASS_HASH,
        }),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.hasher.verifyDummy).toHaveBeenCalledOnce();
  });

  it('calls verifyDummy and returns invalid-credentials when passwordHash is null/falsy', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ status: 'active' }),
          passwordHash: null,
        }),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.hasher.verifyDummy).toHaveBeenCalledOnce();
  });

  // ── emailVerified = false (FR-012a) ────────────────────────────────────────
  it('returns invalid-credentials when emailVerified is false (FR-012a)', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ emailVerified: false }),
          passwordHash: PASS_HASH,
        }),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.hasher.verifyDummy).toHaveBeenCalledOnce();
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'sign_in_failure',
        summary: expect.stringContaining('FR-012a'),
      }),
    );
  });

  // ── requiresPasswordReset = true (FR-012b) ─────────────────────────────────
  it('returns invalid-credentials when requiresPasswordReset is true (FR-012b)', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ requiresPasswordReset: true }),
          passwordHash: PASS_HASH,
        }),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.hasher.verifyDummy).toHaveBeenCalledOnce();
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'sign_in_failure',
        summary: expect.stringContaining('FR-012b'),
      }),
    );
  });

  // ── Locked user ────────────────────────────────────────────────────────────
  it('returns account-locked when lockedUntil is in the future', async () => {
    const lockedUntil = new Date(NOW.getTime() + 10 * 60 * 1000); // 10 min from now
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ lockedUntil }),
          passwordHash: PASS_HASH,
        }),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('account-locked');
      if (result.error.code === 'account-locked') {
        expect(result.error.retryAfterSeconds).toBeGreaterThan(0);
      }
    }
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sign_in_failure', summary: expect.stringContaining('locked') }),
    );
  });

  // ── Wrong password (no lockout yet) ───────────────────────────────────────
  it('returns invalid-credentials and increments failed count on wrong password (count < 5)', async () => {
    const deps = makeDeps({
      hasher: {
        verify: vi.fn().mockResolvedValue(false),
        verifyDummy: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['hasher'],
      users: {
        findByEmail: vi.fn().mockResolvedValue({ user: makeUser(), passwordHash: PASS_HASH }),
        incrementFailedCount: vi.fn().mockResolvedValue(2), // below threshold
        setLocked: vi.fn().mockResolvedValue(undefined),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
        updateLastSignIn: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.users.incrementFailedCount).toHaveBeenCalledWith(USER_ID);
    expect(deps.users.setLocked).not.toHaveBeenCalled();
    expect(authMetrics.lockout).not.toHaveBeenCalled();
  });

  // ── Wrong password AT count = 5 → triggers lockout ────────────────────────
  it('triggers lockout when wrong password count reaches 5', async () => {
    const deps = makeDeps({
      hasher: {
        verify: vi.fn().mockResolvedValue(false),
        verifyDummy: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['hasher'],
      users: {
        findByEmail: vi.fn().mockResolvedValue({ user: makeUser(), passwordHash: PASS_HASH }),
        incrementFailedCount: vi.fn().mockResolvedValue(5), // AT threshold
        setLocked: vi.fn().mockResolvedValue(undefined),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
        updateLastSignIn: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.users.setLocked).toHaveBeenCalledOnce();
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'lockout_triggered' }),
    );
    expect(authMetrics.lockout).toHaveBeenCalledOnce();
  });

  it('triggers lockout when wrong password count exceeds 5 (count > 5)', async () => {
    const deps = makeDeps({
      hasher: {
        verify: vi.fn().mockResolvedValue(false),
        verifyDummy: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['hasher'],
      users: {
        findByEmail: vi.fn().mockResolvedValue({ user: makeUser(), passwordHash: PASS_HASH }),
        incrementFailedCount: vi.fn().mockResolvedValue(7),
        setLocked: vi.fn().mockResolvedValue(undefined),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
        updateLastSignIn: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['users'],
    });
    await signIn(BASE_INPUT, deps);
    expect(deps.users.setLocked).toHaveBeenCalledOnce();
  });

  // ── Portal mismatch ────────────────────────────────────────────────────────
  it('returns invalid-credentials on portal mismatch (member tries staff portal)', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ role: 'member' }), // member role → should use 'member' portal
          passwordHash: PASS_HASH,
        }),
        incrementFailedCount: vi.fn(),
        setLocked: vi.fn(),
        clearFailedCount: vi.fn(),
        updateLastSignIn: vi.fn(),
      } as unknown as SignInDeps['users'],
    });
    // Trying to sign in via 'staff' portal with a 'member' role account
    const result = await signIn({ ...BASE_INPUT, portal: 'staff' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'sign_in_failure',
        summary: expect.stringContaining('portal mismatch'),
      }),
    );
  });

  it('returns invalid-credentials on portal mismatch (admin tries member portal)', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ role: 'admin' }), // admin → staff portal
          passwordHash: PASS_HASH,
        }),
        incrementFailedCount: vi.fn(),
        setLocked: vi.fn(),
        clearFailedCount: vi.fn(),
        updateLastSignIn: vi.fn(),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn({ ...BASE_INPUT, portal: 'member' }, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-credentials');
  });

  // ── Success path ───────────────────────────────────────────────────────────
  it('returns ok({ session, user }) on the happy path', async () => {
    const session = makeSession();
    const deps = makeDeps({
      sessions: {
        create: vi.fn().mockResolvedValue(session),
      } as unknown as SignInDeps['sessions'],
    });
    const result = await signIn(BASE_INPUT, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.session).toEqual(session);
      expect(result.value.user.id).toBe(USER_ID);
    }
    expect(deps.users.clearFailedCount).toHaveBeenCalledWith(USER_ID);
    expect(deps.users.updateLastSignIn).toHaveBeenCalledWith(USER_ID, NOW);
    expect(deps.audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sign_in_success' }),
    );
  });

  it('calls authMetrics.signInAttempt and signInDuration on every call', async () => {
    const deps = makeDeps();
    await signIn(BASE_INPUT, deps);
    expect(authMetrics.signInAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ portal: 'staff', outcome: 'success' }),
    );
    expect(authMetrics.signInDuration).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ portal: 'staff', outcome: 'success' }),
    );
  });

  it('reports account_disabled outcome label to metrics', async () => {
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ status: 'disabled' }),
          passwordHash: PASS_HASH,
        }),
      } as unknown as SignInDeps['users'],
    });
    await signIn(BASE_INPUT, deps);
    expect(authMetrics.signInAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'account_disabled' }),
    );
  });

  it('reports account_locked outcome label to metrics', async () => {
    const lockedUntil = new Date(NOW.getTime() + 60_000);
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({
          user: makeUser({ lockedUntil }),
          passwordHash: PASS_HASH,
        }),
      } as unknown as SignInDeps['users'],
    });
    await signIn(BASE_INPUT, deps);
    expect(authMetrics.signInAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'account_locked' }),
    );
  });

  it('reports rate_limited outcome label to metrics', async () => {
    const deps = makeDeps({
      limiter: {
        check: vi.fn()
          .mockResolvedValueOnce({ success: false, reset: Date.now() + 1_000 })
          .mockResolvedValueOnce({ success: true, reset: Date.now() + 1_000 }),
      } as unknown as SignInDeps['limiter'],
    });
    await signIn(BASE_INPUT, deps);
    expect(authMetrics.signInAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'rate_limited' }),
    );
  });

  it('reports invalid_credentials outcome label to metrics on bad email', async () => {
    const deps = makeDeps();
    await signIn({ ...BASE_INPUT, email: 'bad' }, deps);
    expect(authMetrics.signInAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'invalid_credentials' }),
    );
  });

  // ── expectedPortal helper ─────────────────────────────────────────────────
  it('expectedPortal returns staff for admin', () => {
    expect(expectedPortal('admin')).toBe('staff');
  });

  it('expectedPortal returns staff for manager', () => {
    expect(expectedPortal('manager')).toBe('staff');
  });

  it('expectedPortal returns member for member', () => {
    expect(expectedPortal('member')).toBe('member');
  });

  // ── Success path for member role ───────────────────────────────────────────
  it('succeeds when a member signs in via the member portal', async () => {
    const memberUser = makeUser({ role: 'member' });
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({ user: memberUser, passwordHash: PASS_HASH }),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
        updateLastSignIn: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn({ ...BASE_INPUT, portal: 'member' }, deps);
    expect(result.ok).toBe(true);
  });

  it('succeeds when a manager signs in via the staff portal', async () => {
    const managerUser = makeUser({ role: 'manager' });
    const deps = makeDeps({
      users: {
        findByEmail: vi.fn().mockResolvedValue({ user: managerUser, passwordHash: PASS_HASH }),
        clearFailedCount: vi.fn().mockResolvedValue(undefined),
        updateLastSignIn: vi.fn().mockResolvedValue(undefined),
      } as unknown as SignInDeps['users'],
    });
    const result = await signIn({ ...BASE_INPUT, portal: 'staff' }, deps);
    expect(result.ok).toBe(true);
  });

  // ── G3 (Round 2): MalformedHashError branch ─────────────────────────────
  // When the stored hash is corrupted, sign-in MUST:
  //   1. NOT increment failedSignInCount (the user did not type wrong)
  //   2. NOT setLocked (DB corruption is not credential brute-force)
  //   3. Emit password_malformed_hash_detected audit (operator signal)
  //   4. Return invalid-credentials (UX consistent with wrong-password)
  // Pre-B4 the malformed-hash error was swallowed to false and the
  // flow locked the legitimate user out — covered by this pin.
  it('MalformedHashError: skips lockout + emits dedicated audit + returns invalid-credentials', async () => {
    const { MalformedHashError } = await import(
      '@/modules/auth/infrastructure/password/argon2-hasher'
    );
    const targetUser = makeUser({ role: 'admin', failedSignInCount: 0 });
    const incrementSpy = vi.fn().mockResolvedValue(1);
    const setLockedSpy = vi.fn().mockResolvedValue(undefined);
    const auditSpy = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      users: {
        findByEmail: vi
          .fn()
          .mockResolvedValue({ user: targetUser, passwordHash: PASS_HASH }),
        incrementFailedCount: incrementSpy,
        setLocked: setLockedSpy,
        clearFailedCount: vi.fn(),
        updateLastSignIn: vi.fn(),
      } as unknown as SignInDeps['users'],
      hasher: {
        verify: vi.fn().mockRejectedValue(
          new MalformedHashError(new Error('argon2: invalid encoded hash')),
        ),
        verifyDummy: vi.fn().mockResolvedValue(undefined),
        hash: vi.fn(),
      } as unknown as SignInDeps['hasher'],
      audit: { append: auditSpy } as unknown as SignInDeps['audit'],
    });

    const result = await signIn(BASE_INPUT, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-credentials');

    // NO lockout path executed
    expect(incrementSpy).not.toHaveBeenCalled();
    expect(setLockedSpy).not.toHaveBeenCalled();

    // O6 (Round 3) — verifyDummy MUST NOT be called either. The
    // malformed-hash branch is purely a peek-detect-and-skip path:
    // we already KNOW the user exists (we just loaded their row)
    // and the hash is broken, so spending the argon2 cost to feign
    // a constant-time path is pointless + slows the request.
    const hasherMock = deps.hasher as unknown as {
      verifyDummy: ReturnType<typeof vi.fn>;
    };
    expect(hasherMock.verifyDummy).not.toHaveBeenCalled();

    // Dedicated audit event emitted
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'password_malformed_hash_detected',
        actorUserId: targetUser.id,
        targetUserId: targetUser.id,
        // O6 (Round 3) — pin that the summary surfaces the
        // operator-relevant signal so an alert on "malformed" in
        // the audit_log.summary column reliably fires.
        summary: expect.stringContaining('malformed'),
      }),
    );
  });

  it('MalformedHashError: re-throws non-malformed verify errors', async () => {
    const targetUser = makeUser({ role: 'admin' });
    const deps = makeDeps({
      users: {
        findByEmail: vi
          .fn()
          .mockResolvedValue({ user: targetUser, passwordHash: PASS_HASH }),
        incrementFailedCount: vi.fn(),
        clearFailedCount: vi.fn(),
        updateLastSignIn: vi.fn(),
      } as unknown as SignInDeps['users'],
      hasher: {
        verify: vi
          .fn()
          .mockRejectedValue(new Error('argon2: native module crashed')),
        verifyDummy: vi.fn().mockResolvedValue(undefined),
        hash: vi.fn(),
      } as unknown as SignInDeps['hasher'],
    });

    await expect(signIn(BASE_INPUT, deps)).rejects.toThrow(
      'argon2: native module crashed',
    );
  });
});
