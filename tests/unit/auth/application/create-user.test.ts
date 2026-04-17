/**
 * Unit tests for `createUser` use case (T049 / F3 close-out).
 *
 * Covers the 4 branches of the state machine:
 *   1. Happy path — user + invitation + enqueue + audit all succeed.
 *   2. invalid-input — malformed email short-circuits before repo calls.
 *   3. email-taken — duplicate rejects without creating a user.
 *   4. invitation-create-failed — createInvitation throws AFTER
 *      createPending commits; compensating delete runs; error surfaces.
 *   5. enqueue non-fatal — outbox enqueue fails, user + invitation
 *      persist, audit still fires, use case returns ok.
 *
 * Mirrors the deps-injection pattern from sign-in.test.ts.
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
    findByEmail: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    updateLastSignIn: vi.fn(),
    incrementFailedCount: vi.fn(),
    clearFailedCount: vi.fn(),
    setLocked: vi.fn(),
    clearLock: vi.fn(),
    countActiveAdmins: vi.fn(),
    createPending: vi.fn().mockResolvedValue(PENDING_USER),
    deletePending: vi.fn().mockResolvedValue(undefined),
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
    createInvitation: vi
      .fn()
      .mockResolvedValue({ id: INVITATION_ID, userId: PENDING_USER.id }),
    findInvitationById: vi.fn(),
    consumeInvitation: vi.fn(),
    createResetToken: vi.fn(),
    findResetToken: vi.fn(),
    consumeResetToken: vi.fn(),
  } as unknown as CreateUserDeps['tokens'];

  const audit = {
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as CreateUserDeps['audit'];

  const enqueueInvitation = vi.fn().mockResolvedValue(
    ok({ outboxRowId: 'outbox-row-1' }),
  );

  return {
    users,
    tokens,
    audit,
    enqueueInvitation,
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

describe('createUser', () => {
  it('happy path: creates user, invitation, enqueues email, audits', async () => {
    const deps = makeDeps();

    const result = await createUser(baseInput, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.user).toEqual(PENDING_USER);
    expect(result.value.invitationId).toBe(INVITATION_ID);
    expect(deps.users.createPending).toHaveBeenCalledOnce();
    expect(deps.users.deletePending).not.toHaveBeenCalled();
    expect(deps.tokens.createInvitation).toHaveBeenCalledOnce();
    expect(deps.enqueueInvitation).toHaveBeenCalledWith({
      toEmail: PENDING_USER.email,
      token: INVITATION_ID,
      role: 'member',
      locale: undefined,
    });
    expect(deps.audit.append).toHaveBeenCalledOnce();
    expect(authMetrics.invitationSent).toHaveBeenCalledWith('member');
  });

  it('invalid-input: malformed email short-circuits without creating a user', async () => {
    const deps = makeDeps();

    const result = await createUser({ ...baseInput, email: 'not-an-email' }, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-input');
    expect(deps.users.findByEmail).not.toHaveBeenCalled();
    expect(deps.users.createPending).not.toHaveBeenCalled();
    expect(deps.enqueueInvitation).not.toHaveBeenCalled();
  });

  it('email-taken: duplicate rejects without creating the user', async () => {
    const deps = makeDeps();
    (deps.users.findByEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      user: PENDING_USER,
      passwordHash: null,
    });

    const result = await createUser(baseInput, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('email-taken');
    expect(deps.users.createPending).not.toHaveBeenCalled();
    expect(deps.tokens.createInvitation).not.toHaveBeenCalled();
    expect(deps.enqueueInvitation).not.toHaveBeenCalled();
  });

  it('invitation-create-failed: compensating delete runs and use case returns error', async () => {
    const deps = makeDeps();
    (deps.tokens.createInvitation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db connection reset'),
    );

    const result = await createUser(baseInput, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invitation-create-failed');
    expect(deps.users.createPending).toHaveBeenCalledOnce();
    expect(deps.users.deletePending).toHaveBeenCalledWith(PENDING_USER.id);
    expect(deps.enqueueInvitation).not.toHaveBeenCalled();
    expect(deps.audit.append).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errMessage: 'db connection reset' }),
      'create_user.invitation_create_failed',
    );
  });

  it('compensating delete swallows its own error and still returns the outer failure', async () => {
    const deps = makeDeps();
    (deps.tokens.createInvitation as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('invitation failed'),
    );
    (deps.users.deletePending as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('delete failed'),
    );

    const result = await createUser(baseInput, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invitation-create-failed');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errMessage: 'delete failed' }),
      'create_user.compensating_delete_failed',
    );
  });

  it('enqueue non-fatal: outbox enqueue failure logs but use case returns ok', async () => {
    const deps = makeDeps({
      enqueueInvitation: vi
        .fn()
        .mockResolvedValue(err({ code: 'enqueue_failed', cause: 'connection reset' })),
    });

    const result = await createUser(baseInput, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invitationId).toBe(INVITATION_ID);
    expect(deps.users.deletePending).not.toHaveBeenCalled();
    expect(deps.audit.append).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        errCode: 'enqueue_failed',
        errCause: 'connection reset',
      }),
      'create_user.invitation_enqueue_failed',
    );
  });

  it('passes locale through to the outbox enqueue request', async () => {
    const deps = makeDeps();

    await createUser({ ...baseInput, locale: 'th' }, deps);

    expect(deps.enqueueInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'th' }),
    );
  });
});
