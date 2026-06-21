/**
 * Unit — `authUserErasureAdapter` (COMP-1 US2a).
 *
 * The adapter is the single allowed F3 (members) → F1 (auth) crossing point
 * for linked-login erasure. It maps the members-side `UserErasurePort` input
 * (`userId` + `{ actorUserId, requestId }`) onto the auth `EraseUserInput`
 * (`{ userId, actorUserId, requestId, sourceIp }`), calls the auth-barrel
 * `eraseUser` use-case, and translates its `Result<EraseUserSuccess,
 * EraseUserError>` back to the port's `Result<{ erased }, { code }>`.
 *
 * Contract pinned here:
 *   1. happy path — input is mapped onto EraseUserInput correctly; ok({erased})
 *      flows through unchanged.
 *   2. requestId null → 'system:erase-cascade' sentinel (so the audit row
 *      always carries a non-empty, `system:*`-greppable requestId; sourceIp is
 *      always null on this server-side path).
 *   3. auth err → port err({code}) — NOT a throw (best-effort; the eraseMember
 *      post-commit cascade flips allCascadesClean so US2d re-drives).
 *   4. auth THROWS (eraseUser is never-throws by contract, but the adapter must
 *      survive a calling-convention throw) → port err({code}), loop-safe.
 *
 * Reliability-review hardening pinned here (COMP-1 US2a Task 5):
 *   - M-1: the auth-err path (most common failure — Neon down) logs BEFORE
 *     returning, symmetric with the throw path, carrying the `cause` so the
 *     US2d reconciler + on-call can trace which linked user failed and why.
 *   - M-2: BOTH failure paths emit `authMetrics.eraseCascadeOutcome(outcome)`
 *     so a stuck cascade (security-relevant: an erased member can still sign in)
 *     is alertable on a bounded label, not just a log grep.
 *   - L-1: assert the log + metric on BOTH failure paths so a regression that
 *     re-mutes a stuck cascade fails the suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Spy on the F1 erasure-cascade outcome counter (M-2). Mirror of the
// archive-member cascade-metric mock pattern (importActual + spread +
// override) so the rest of `authMetrics` keeps its real implementation.
const { eraseCascadeOutcomeSpy } = vi.hoisted(() => ({
  eraseCascadeOutcomeSpy: vi.fn(),
}));
vi.mock('@/lib/metrics', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    authMetrics: {
      ...actual.authMetrics,
      eraseCascadeOutcome: eraseCascadeOutcomeSpy,
    },
  };
});

const { eraseUser } = vi.hoisted(() => ({ eraseUser: vi.fn() }));
vi.mock('@/modules/auth', () => ({ eraseUser }));

import { logger } from '@/lib/logger';
import { authUserErasureAdapter } from '@/modules/members/infrastructure/adapters/auth-user-erasure-adapter';

describe('authUserErasureAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps the port input onto EraseUserInput and forwards ok({erased:true})', async () => {
    eraseUser.mockResolvedValueOnce(ok({ erased: true }));

    const result = await authUserErasureAdapter.eraseUser('user-1', {
      actorUserId: 'admin-1',
      requestId: 'req-1',
    });

    expect(eraseUser).toHaveBeenCalledWith({
      userId: 'user-1',
      actorUserId: 'admin-1',
      requestId: 'req-1',
      sourceIp: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.erased).toBe(true);
    // Happy path emits no failure log + no failure metric.
    expect(logger.error).not.toHaveBeenCalled();
    expect(eraseCascadeOutcomeSpy).not.toHaveBeenCalled();
  });

  it('forwards ok({erased:false}) — the no-op (row already gone) success', async () => {
    eraseUser.mockResolvedValueOnce(ok({ erased: false }));

    const result = await authUserErasureAdapter.eraseUser('user-missing', {
      actorUserId: 'admin-1',
      requestId: 'req-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.erased).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();
    expect(eraseCascadeOutcomeSpy).not.toHaveBeenCalled();
  });

  it('substitutes the "system:erase-cascade" requestId sentinel when requestId is null', async () => {
    eraseUser.mockResolvedValueOnce(ok({ erased: true }));

    await authUserErasureAdapter.eraseUser('user-1', {
      actorUserId: 'admin-1',
      requestId: null,
    });

    expect(eraseUser).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'system:erase-cascade',
        sourceIp: null,
      }),
    );
  });

  it('translates an auth err into a port err({code}) — does NOT throw', async () => {
    eraseUser.mockResolvedValueOnce(
      err({ code: 'erase-user-failed', cause: new Error('neon down') }),
    );

    const result = await authUserErasureAdapter.eraseUser('user-1', {
      actorUserId: 'admin-1',
      requestId: 'req-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('erase-user-failed');
  });

  it('M-1: logs the auth-err path BEFORE returning, carrying userId + cascade + cause', async () => {
    eraseUser.mockResolvedValueOnce(
      err({ code: 'erase-user-failed', cause: new Error('neon down') }),
    );

    await authUserErasureAdapter.eraseUser('user-9', {
      actorUserId: 'admin-1',
      requestId: 'req-9',
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = (logger.error as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(payload).toMatchObject({
      err: 'erase-user-failed',
      cause: 'neon down',
      userId: 'user-9',
      requestId: 'req-9',
      cascade: 'f1_user_erasure',
    });
    expect(message).toBe('members.erase.user_erasure_failed');
  });

  it('M-1: stringifies a non-Error cause on the auth-err path', async () => {
    eraseUser.mockResolvedValueOnce(
      err({ code: 'erase-user-failed', cause: 'pg: 57P01 admin shutdown' }),
    );

    await authUserErasureAdapter.eraseUser('user-9', {
      actorUserId: 'admin-1',
      requestId: 'req-9',
    });

    const [payload] = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(payload).toMatchObject({ cause: 'pg: 57P01 admin shutdown' });
  });

  it('M-2: emits eraseCascadeOutcome("failed") on the auth-err path', async () => {
    eraseUser.mockResolvedValueOnce(
      err({ code: 'erase-user-failed', cause: new Error('neon down') }),
    );

    await authUserErasureAdapter.eraseUser('user-9', {
      actorUserId: 'admin-1',
      requestId: 'req-9',
    });

    expect(eraseCascadeOutcomeSpy).toHaveBeenCalledWith('failed');
  });

  it('forwards the distinct last-admin code and meters it on its OWN "last_admin" label', async () => {
    // `eraseUser` returns the distinct last-admin error when the anonymise UPDATE
    // trips the `users_last_admin_protection` trigger. The adapter must (a) forward
    // the distinct `code` unchanged (so the members cascade + DPO see it) and (b)
    // meter it on a SEPARATE `'last_admin'` label so a stuck last-admin erasure is
    // alertable on its own — not buried in the generic 'failed' rate (which is
    // remediated by an operator promoting another admin, not by a Neon recovery).
    eraseUser.mockResolvedValueOnce(
      err({
        code: 'erase-user-last-admin',
        cause: {
          code: '23514',
          message: 'last-admin-protection: cannot disable the sole active admin',
        },
      }),
    );

    const result = await authUserErasureAdapter.eraseUser('user-admin', {
      actorUserId: 'admin-1',
      requestId: 'req-admin',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('erase-user-last-admin');
    // Distinct metric label — NOT 'failed'.
    expect(eraseCascadeOutcomeSpy).toHaveBeenCalledWith('last_admin');
    expect(eraseCascadeOutcomeSpy).not.toHaveBeenCalledWith('failed');
  });

  it('catches an unexpected throw and returns a port err (best-effort loop survives)', async () => {
    eraseUser.mockRejectedValueOnce(new Error('boom'));

    const result = await authUserErasureAdapter.eraseUser('user-1', {
      actorUserId: 'admin-1',
      requestId: 'req-1',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(typeof result.error.code).toBe('string');
  });

  it('L-1: logs + meters the throw path with userId + cascade (forensic-distinct from auth-err)', async () => {
    eraseUser.mockRejectedValueOnce(new Error('boom'));

    await authUserErasureAdapter.eraseUser('user-3', {
      actorUserId: 'admin-1',
      requestId: 'req-3',
    });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [payload, message] = (logger.error as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect(payload).toMatchObject({
      err: 'boom',
      userId: 'user-3',
      requestId: 'req-3',
      cascade: 'f1_user_erasure',
    });
    expect(message).toBe('members.erase.user_erasure_threw');
    // Throw path carries the distinct 'threw' outcome label.
    expect(eraseCascadeOutcomeSpy).toHaveBeenCalledWith('threw');
  });
});
