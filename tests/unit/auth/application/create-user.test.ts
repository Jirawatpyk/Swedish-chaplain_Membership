/**
 * Unit tests for `createUser` use case — Path C atomic rewrite.
 *
 * Covers the state-machine branches of the new `db.transaction`-wrapped
 * flow:
 *
 *   1. Happy path — user + invitation + enqueue + audit all succeed.
 *   2. invalid-input — malformed email short-circuits before opening the tx.
 *   3. email-taken — dup check inside tx throws CreateUserAbort; repo
 *      writes (createPending, createInvitation, audit) are never called.
 *   4. invitation-create-failed via unexpected throw — TokenRepo throws
 *      mid-tx; `db.transaction` rolls back; outer handler re-throws
 *      (not mapped to typed err, because the throw was not a
 *      CreateUserAbort).
 *   5. invitation-create-failed via enqueue err — enqueueInvitationInTx
 *      returns err; use case throws CreateUserAbort; tx rolls back;
 *      outer catch returns err('invitation-create-failed').
 *   6. enqueue failure emits the metric + log (observability gate).
 *   7. Locale passthrough — `th` propagates to enqueueInvitationInTx.
 *
 * The `db.transaction` mock invokes the callback with a dummy tx and
 * re-throws any exception (mirrors Drizzle's real semantics: `return`
 * commits, `throw` rolls back). That contract is what the tests assert.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({ hashId: vi.fn((s: string) => s) }));
vi.mock('@/lib/metrics', () => ({
  authMetrics: {
    invitationSent: vi.fn(),
    invitationEnqueueFailed: vi.fn(),
  },
}));
// `db.transaction(fn)` mock — invokes callback with fake tx; re-throws
// anything thrown inside so the outer catch can observe CreateUserAbort.
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({} as never)),
  },
}));
// Prevent defaultCreateUserDeps from pulling Drizzle at test boot.
vi.mock('@/lib/auth-deps', () => ({ defaultCreateUserDeps: {} }));

import { createUser } from '@/modules/auth/application/create-user';
import type { CreateUserDeps } from '@/modules/auth/application/create-user';
import { asUserId, asEmailAddress, asTokenId } from '@/modules/auth/domain/branded';
import { ok, err } from '@/lib/result';
import { authMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Stubs / fixtures
// ---------------------------------------------------------------------------

const FROZEN_NOW = new Date('2026-04-17T10:00:00Z');
const INVITATION_ID = asTokenId('tok_00000000000000000000000000000001');
const PENDING_USER = {
  id: asUserId('11111111-1111-4111-8111-111111111111'),
  email: asEmailAddress('invitee@swecham.test'),
  role: 'member' as const,
  status: 'pending' as const,
  displayName: null,
  emailVerified: false,
  requiresPasswordReset: false,
  failedSignInCount: 0,
  lockedUntil: null,
  lastSignInAt: null,
  createdAt: FROZEN_NOW,
  updatedAt: FROZEN_NOW,
};

function makeDeps(overrides: Partial<CreateUserDeps> = {}): CreateUserDeps {
  const users = {
    findByEmail: vi.fn(),
    findByEmailInTx: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    updateLastSignIn: vi.fn(),
    incrementFailedCount: vi.fn(),
    clearFailedCount: vi.fn(),
    setLocked: vi.fn(),
    clearLock: vi.fn(),
    countActiveAdmins: vi.fn(),
    createPending: vi.fn(),
    createPendingInTx: vi.fn().mockResolvedValue(PENDING_USER),
    deletePending: vi.fn(),
    setPasswordHash: vi.fn(),
    activate: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    setRole: vi.fn(),
    list: vi.fn(),
    countAll: vi.fn(),
    listWithFilter: vi.fn(),
    countWithFilter: vi.fn(),
  } as unknown as CreateUserDeps['users'];

  const tokens = {
    createInvitation: vi.fn(),
    createInvitationInTx: vi
      .fn()
      .mockResolvedValue({ id: INVITATION_ID, userId: PENDING_USER.id }),
    findInvitationById: vi.fn(),
    markInvitationConsumed: vi.fn(),
    createReset: vi.fn(),
    findResetById: vi.fn(),
    markResetConsumed: vi.fn(),
    invalidateAllUnconsumedForUser: vi.fn(),
  } as unknown as CreateUserDeps['tokens'];

  const audit = {
    append: vi.fn(),
    appendInTx: vi.fn().mockResolvedValue(undefined),
  } as unknown as CreateUserDeps['audit'];

  const enqueueInvitationInTx = vi
    .fn()
    .mockResolvedValue(ok({ outboxRowId: 'outbox-row-1' }));

  return {
    users,
    tokens,
    audit,
    enqueueInvitationInTx,
    now: () => FROZEN_NOW,
    ...overrides,
  };
}

const baseInput = {
  email: 'invitee@swecham.test',
  role: 'member' as const,
  actorUserId: asUserId('22222222-2222-4222-8222-222222222222'),
  sourceIp: '203.0.113.10',
  requestId: 'req-test-001',
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createUser (Path C atomic flow)', () => {
  it('happy path: creates user, invitation, enqueues email, audits — all inside one tx', async () => {
    const deps = makeDeps();

    const result = await createUser(baseInput, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user).toEqual(PENDING_USER);
    expect(result.value.invitationId).toBe(INVITATION_ID);
    expect(deps.users.createPendingInTx).toHaveBeenCalledOnce();
    expect(deps.tokens.createInvitationInTx).toHaveBeenCalledOnce();
    expect(deps.enqueueInvitationInTx).toHaveBeenCalledWith(expect.anything(), {
      toEmail: PENDING_USER.email,
      token: INVITATION_ID,
      role: 'member',
      locale: undefined,
    });
    expect(deps.audit.appendInTx).toHaveBeenCalledOnce();
    expect(authMetrics.invitationSent).toHaveBeenCalledWith('member');
    // Non-tx paths MUST NOT be used by the atomic flow.
    expect(deps.users.createPending).not.toHaveBeenCalled();
    expect(deps.users.deletePending).not.toHaveBeenCalled();
    expect(deps.audit.append).not.toHaveBeenCalled();
  });

  it('invalid-input: malformed email short-circuits without opening the tx', async () => {
    const deps = makeDeps();

    const result = await createUser({ ...baseInput, email: 'not-an-email' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-input');
    expect(deps.users.findByEmailInTx).not.toHaveBeenCalled();
    expect(deps.users.createPendingInTx).not.toHaveBeenCalled();
    expect(deps.enqueueInvitationInTx).not.toHaveBeenCalled();
    expect(deps.audit.appendInTx).not.toHaveBeenCalled();
  });

  it('email-taken: dup check inside tx throws CreateUserAbort — no writes executed', async () => {
    const deps = makeDeps();
    (deps.users.findByEmailInTx as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: PENDING_USER,
      passwordHash: null,
    });

    const result = await createUser(baseInput, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('email-taken');
    expect(deps.users.createPendingInTx).not.toHaveBeenCalled();
    expect(deps.tokens.createInvitationInTx).not.toHaveBeenCalled();
    expect(deps.enqueueInvitationInTx).not.toHaveBeenCalled();
    expect(deps.audit.appendInTx).not.toHaveBeenCalled();
  });

  it('unexpected tx error: TokenRepo throw is re-raised (not mapped to typed err)', async () => {
    const deps = makeDeps();
    (
      deps.tokens.createInvitationInTx as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error('db connection reset'));

    // Path C: an unexpected throw (not CreateUserAbort) propagates out
    // of the outer catch so the route handler maps it to 500. This is
    // different from pre-Path-C where the throw was caught + mapped to
    // invitation-create-failed.
    await expect(createUser(baseInput, deps)).rejects.toThrow(
      'db connection reset',
    );

    // No compensating delete — the tx rollback handles it.
    expect(deps.users.deletePending).not.toHaveBeenCalled();
    // Audit inside tx is also rolled back, so the in-tx call happened
    // (createPending succeeded) but never committed.
    expect(deps.audit.appendInTx).not.toHaveBeenCalled();
  });

  it('enqueue err: CreateUserAbort + rollback; returns typed invitation-create-failed', async () => {
    const deps = makeDeps({
      enqueueInvitationInTx: vi
        .fn()
        .mockResolvedValue(err({ code: 'enqueue_failed', cause: 'connection reset' })),
    });

    const result = await createUser(baseInput, deps);

    // Admin sees a typed 500 (no silent-success) + tx rolled back.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invitation-create-failed');
    expect(deps.audit.appendInTx).not.toHaveBeenCalled();
    expect(deps.users.deletePending).not.toHaveBeenCalled();
  });

  it('enqueue err: logs create_user.invitation_enqueue_failed + emits metric', async () => {
    const deps = makeDeps({
      enqueueInvitationInTx: vi
        .fn()
        .mockResolvedValue(err({ code: 'enqueue_failed', cause: 'timeout' })),
    });

    await createUser(baseInput, deps);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errCode: 'enqueue_failed',
        errCause: 'timeout',
      }),
      'create_user.invitation_enqueue_failed',
    );
    expect(authMetrics.invitationEnqueueFailed).toHaveBeenCalledWith(
      'member',
      'enqueue_failed',
    );
    // invitationSent NOT fired on rollback — metric stays accurate.
    expect(authMetrics.invitationSent).not.toHaveBeenCalled();
  });

  it('passes locale through to the outbox enqueue request', async () => {
    const deps = makeDeps();

    await createUser({ ...baseInput, locale: 'th' }, deps);

    expect(deps.enqueueInvitationInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locale: 'th' }),
    );
  });
});
