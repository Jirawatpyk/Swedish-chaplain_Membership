/**
 * Unit tests for `reissueInvitation` use case (F1 primitive backing F3
 * `resendBouncedInvite`). Owner-role `db.transaction` flow.
 *
 * Branches covered:
 *   1. Happy path — pending user → mint + enqueue → ok {invitationId, email, role}.
 *   2. user-not-found — findByIdInTx returns null; no mint/enqueue.
 *   3. not-pending — user.status !== 'pending'; mint NOT attempted (security
 *      guard: refuses to re-issue for an active/disabled account).
 *   4. reissue-failed — enqueue returns err; TxAbort rolls back; metric fired.
 *   5. intendedRole is derived from the LOCKED user row, never the caller.
 *   6. unexpected throw mid-tx re-raises (not mapped to a typed err).
 *
 * `db.transaction` mock invokes the callback with a fake tx and re-throws
 * anything thrown inside (mirrors Drizzle: return commits, throw rolls back).
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
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({} as never)),
  },
}));
vi.mock('@/lib/auth-deps', () => ({ defaultReissueInvitationDeps: {} }));

import { reissueInvitation } from '@/modules/auth/application/reissue-invitation';
import type { ReissueInvitationDeps } from '@/modules/auth/application/reissue-invitation';
import { asUserId, asEmailAddress, asTokenId } from '@/modules/auth/domain/branded';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';
import { ok, err } from '@/lib/result';
import { authMetrics } from '@/lib/metrics';

const FROZEN_NOW = new Date('2026-05-22T10:00:00Z');
const INVITATION_ID = asTokenId('tok_00000000000000000000000000000009');
const USER_ID = asUserId('33333333-3333-4333-8333-333333333333');
const ACTOR_ID = asUserId('44444444-4444-4444-8444-444444444444');

function pendingUser(role: 'member' | 'manager' | 'admin' = 'member') {
  return {
    id: USER_ID,
    email: asEmailAddress('invitee@swecham.test'),
    role,
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
}

function makeDeps(
  overrides: {
    user?: ReturnType<typeof pendingUser> | null;
    createThrows?: Error;
    enqueueResult?: ReturnType<typeof ok> | ReturnType<typeof err>;
  } = {},
): ReissueInvitationDeps {
  const users = {
    findByIdInTx: vi
      .fn()
      .mockResolvedValue('user' in overrides ? overrides.user : pendingUser()),
  } as unknown as ReissueInvitationDeps['users'];

  const createInvitationInTx = overrides.createThrows
    ? vi.fn().mockRejectedValue(overrides.createThrows)
    : vi.fn().mockResolvedValue({
        plaintext: INVITATION_ID,
        invitation: { id: INVITATION_ID, userId: USER_ID },
      });
  const tokens = {
    createInvitationInTx,
  } as unknown as ReissueInvitationDeps['tokens'];

  const enqueueInvitationInTx = vi
    .fn()
    .mockResolvedValue(overrides.enqueueResult ?? ok({ outboxRowId: 'outbox-row-9' }));

  return {
    users,
    tokens,
    enqueueInvitationInTx,
    now: () => FROZEN_NOW,
  };
}

const input = {
  userId: USER_ID,
  invitedByUserId: ACTOR_ID,
  locale: 'en' as const,
  tenantId: 'test-tenant' as TenantSlug,
  requestId: 'req-reissue-1',
};

describe('reissueInvitation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('happy path — mints + enqueues, returns ok {invitationId, email, role}', async () => {
    const deps = makeDeps();
    const result = await reissueInvitation(input, deps);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.invitationId).toBe(INVITATION_ID);
      expect(result.value.email).toBe('invitee@swecham.test');
      expect(result.value.role).toBe('member');
    }
    expect(deps.tokens.createInvitationInTx).toHaveBeenCalledTimes(1);
    expect(deps.enqueueInvitationInTx).toHaveBeenCalledTimes(1);
    expect(authMetrics.invitationSent).toHaveBeenCalledWith('member');
  });

  it('returns user-not-found when the user row is gone; never mints', async () => {
    const deps = makeDeps({ user: null });
    const result = await reissueInvitation(input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('user-not-found');
    expect(deps.tokens.createInvitationInTx).not.toHaveBeenCalled();
    expect(deps.enqueueInvitationInTx).not.toHaveBeenCalled();
  });

  it('SECURITY: refuses to re-issue for a non-pending user; never mints', async () => {
    const deps = makeDeps({ user: { ...pendingUser(), status: 'active' as never } });
    const result = await reissueInvitation(input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-pending');
    expect(deps.tokens.createInvitationInTx).not.toHaveBeenCalled();
    expect(deps.enqueueInvitationInTx).not.toHaveBeenCalled();
  });

  it('returns reissue-failed + fires metric when enqueue fails (tx rolls back)', async () => {
    const deps = makeDeps({ enqueueResult: err({ code: 'enqueue_failed' }) });
    const result = await reissueInvitation(input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('reissue-failed');
    expect(deps.tokens.createInvitationInTx).toHaveBeenCalledTimes(1);
    expect(authMetrics.invitationEnqueueFailed).toHaveBeenCalledWith(
      'member',
      'enqueue_failed',
    );
    // Aborted tx → not counted as sent.
    expect(authMetrics.invitationSent).not.toHaveBeenCalled();
  });

  it('derives intendedRole from the LOCKED user row, NOT the caller', async () => {
    const deps = makeDeps({ user: pendingUser('manager') });
    await reissueInvitation(input, deps);
    const call = (deps.tokens.createInvitationInTx as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call?.[1]).toMatchObject({ userId: USER_ID, intendedRole: 'manager' });
  });

  it('re-raises an unexpected throw (not a typed err)', async () => {
    const deps = makeDeps({ createThrows: new Error('neon connection lost') });
    await expect(reissueInvitation(input, deps)).rejects.toThrow(
      'neon connection lost',
    );
  });
});
