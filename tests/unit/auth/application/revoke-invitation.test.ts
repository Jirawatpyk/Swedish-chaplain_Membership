/**
 * Unit tests for `revokeInvitation` use case (Staff Invitation Lifecycle,
 * Task 3).
 *
 * Security-critical destructive op (deletes a pending user row). Deletes the
 * user + cleans its queued `notifications_outbox` invite row(s) BY EMAIL
 * (RA-2 — the outbox table has no `user_id` column) + audits
 * `invitation_revoked`, all inside ONE `db.transaction`:
 *
 *   1. happy path — `deleteInvitedPendingInTx` returns `{deleted:1, email}` →
 *      outbox cleaned by (email, tenantId) → `invitation_revoked` audited →
 *      `ok({deleted:true})`.
 *   2. not-pending-or-not-found — `{deleted:0, email:null}` → NEITHER the
 *      outbox cleanup NOR the audit runs → `err({code:'not-pending-or-not-found'})`.
 *   3. audit summary prefers `targetEmail`, falls back to the RETURNING
 *      `email`, falls back to `userId`.
 *   4. atomicity — if the outbox delete throws mid-tx, the error propagates
 *      out (Drizzle rolls the whole tx back: user delete + audit never
 *      commit) and the audit is never reached.
 *
 * The `db.transaction` mock invokes the callback with a dummy tx and
 * re-throws (mirrors Drizzle: `return` commits, `throw` rolls back) — same
 * convention as delete-invited-user.test.ts / reissue-invitation tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// db.transaction(fn) — invoke callback with a fake tx; re-throw inner errors so
// the outer catch in the use case observes them (Drizzle rollback semantics).
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({} as never)),
  },
}));
// Prevent defaultRevokeInvitationDeps from pulling Drizzle at test boot.
vi.mock('@/lib/auth-deps', () => ({ defaultRevokeInvitationDeps: {} }));

import { revokeInvitation } from '@/modules/auth/application/revoke-invitation';
import type { RevokeInvitationDeps } from '@/modules/auth/application/revoke-invitation';
import { asUserId } from '@/modules/auth/domain/branded';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';

const USER_ID = asUserId('11111111-1111-4111-8111-111111111111');
const ACTOR_ID = asUserId('22222222-2222-4222-8222-222222222222');
const TENANT_ID = 'test-tenant' as TenantSlug;

function makeDeps(overrides: {
  deleteResult?: { deleted: number; email: string | null };
  outboxThrows?: unknown;
} = {}): {
  deps: RevokeInvitationDeps;
  deleteInvitedPendingInTx: ReturnType<typeof vi.fn>;
  deleteInviteOutboxByEmailInTx: ReturnType<typeof vi.fn>;
  appendInTx: ReturnType<typeof vi.fn>;
} {
  const deleteInvitedPendingInTx = vi.fn(
    async () => overrides.deleteResult ?? { deleted: 1, email: 'invitee@swecham.test' },
  );
  const deleteInviteOutboxByEmailInTx =
    overrides.outboxThrows !== undefined
      ? vi.fn(async () => {
          throw overrides.outboxThrows;
        })
      : vi.fn(async () => undefined);
  const appendInTx = vi.fn(async () => undefined);
  const deps: RevokeInvitationDeps = {
    users: {
      deleteInvitedPendingInTx,
      deleteInviteOutboxByEmailInTx,
    } as unknown as RevokeInvitationDeps['users'],
    audit: { appendInTx } as unknown as RevokeInvitationDeps['audit'],
  };
  return { deps, deleteInvitedPendingInTx, deleteInviteOutboxByEmailInTx, appendInTx };
}

const baseInput = {
  userId: USER_ID,
  actorUserId: ACTOR_ID,
  tenantId: TENANT_ID,
  sourceIp: '203.0.113.11',
  requestId: 'req-revoke-001',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('revokeInvitation', () => {
  it('happy path — deletes the pending user, cleans the outbox by email, audits invitation_revoked, returns ok({deleted:true})', async () => {
    const { deps, deleteInvitedPendingInTx, deleteInviteOutboxByEmailInTx, appendInTx } =
      makeDeps();

    const result = await revokeInvitation(baseInput, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ deleted: true });

    expect(deleteInvitedPendingInTx).toHaveBeenCalledOnce();
    expect(deleteInvitedPendingInTx).toHaveBeenCalledWith(expect.anything(), USER_ID);

    expect(deleteInviteOutboxByEmailInTx).toHaveBeenCalledOnce();
    expect(deleteInviteOutboxByEmailInTx).toHaveBeenCalledWith(
      expect.anything(),
      'invitee@swecham.test',
      TENANT_ID,
    );

    expect(appendInTx).toHaveBeenCalledOnce();
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invitation_revoked',
        actorUserId: ACTOR_ID,
        targetUserId: USER_ID,
        sourceIp: baseInput.sourceIp,
        requestId: baseInput.requestId,
      }),
    );
  });

  it('not-pending-or-not-found: 0 rows deleted → err, NO outbox cleanup, NO audit', async () => {
    const { deps, deleteInviteOutboxByEmailInTx, appendInTx } = makeDeps({
      deleteResult: { deleted: 0, email: null },
    });

    const result = await revokeInvitation(baseInput, deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not-pending-or-not-found');
    expect(deleteInviteOutboxByEmailInTx).not.toHaveBeenCalled();
    expect(appendInTx).not.toHaveBeenCalled();
  });

  it('audit summary prefers targetEmail over the RETURNING email', async () => {
    const { deps, appendInTx } = makeDeps();
    await revokeInvitation({ ...baseInput, targetEmail: 'typed-by-admin@swecham.test' }, deps);
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: expect.stringContaining('typed-by-admin@swecham.test'),
      }),
    );
  });

  it('audit summary falls back to the RETURNING email when no targetEmail is given', async () => {
    const { deps, appendInTx } = makeDeps();
    await revokeInvitation(baseInput, deps);
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        summary: expect.stringContaining('invitee@swecham.test'),
      }),
    );
  });

  it('atomicity: outbox delete throws mid-tx → error propagates, audit never reached', async () => {
    const boom = new Error('neon connection reset mid-delete');
    const { deps, appendInTx } = makeDeps({ outboxThrows: boom });

    await expect(revokeInvitation(baseInput, deps)).rejects.toThrow(boom);
    expect(appendInTx).not.toHaveBeenCalled();
  });
});
