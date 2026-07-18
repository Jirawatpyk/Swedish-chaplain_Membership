/**
 * Unit tests for `pruneExpiredInvitations` use case (Staff Invitation
 * Lifecycle, Task 6 — final-review nit fix #2, added post-ship).
 *
 * Cron-driven best-effort maintenance sweep: bulk-deletes long-dead
 * `pending` invited users, cleans their cross-tenant `notifications_outbox`
 * rows by email, and audits ONE `invitation_expired` row per pruned user —
 * all inside a single `db.transaction`. No error variant
 * (`Result<Success, never>`), so these tests cover:
 *
 *   1. happy path — 2 pruned rows → `ok({prunedCount:2})`, outbox cleanup
 *      called once per row (by email), `invitation_expired` audited once
 *      per row with `actorUserId:'system:cron'`.
 *   2. `graceDays` default = 30 — omitting it from the input still computes
 *      cutoff = `now - 30*86_400_000`.
 *   3. atomicity — if a mid-batch step throws (outbox delete), the error
 *      propagates out of the use case (Drizzle rolls the whole tx back);
 *      the throw is NOT swallowed and audit is never reached for that row.
 *
 * The `db.transaction` mock invokes the callback with a dummy tx and
 * re-throws (mirrors Drizzle: `return` commits, `throw` rolls back) — same
 * convention as revoke-invitation.test.ts / delete-invited-user.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// db.transaction(fn) — invoke callback with a fake tx; re-throw inner errors so
// the outer catch (if any) / the caller observes them (Drizzle rollback semantics).
vi.mock('@/lib/db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({} as never)),
  },
}));
// Prevent defaultPruneExpiredInvitationsDeps from pulling Drizzle at test boot.
vi.mock('@/lib/auth-deps', () => ({ defaultPruneExpiredInvitationsDeps: {} }));

import { pruneExpiredInvitations } from '@/modules/auth/application/prune-expired-invitations';
import type { PruneExpiredInvitationsDeps } from '@/modules/auth/application/prune-expired-invitations';

const USER_ID_1 = '11111111-1111-4111-8111-111111111111';
const USER_ID_2 = '22222222-2222-4222-8222-222222222222';

function makeDeps(
  overrides: {
    prunedRows?: ReadonlyArray<{ userId: string; email: string }>;
    outboxThrows?: unknown;
    auditThrows?: unknown;
  } = {},
): {
  deps: PruneExpiredInvitationsDeps;
  deletePendingInvitesExpiredBeforeInTx: ReturnType<typeof vi.fn>;
  deleteInviteOutboxByEmailAllTenantsInTx: ReturnType<typeof vi.fn>;
  appendInTx: ReturnType<typeof vi.fn>;
} {
  const prunedRows = overrides.prunedRows ?? [];
  const deletePendingInvitesExpiredBeforeInTx = vi.fn(async () => prunedRows);
  const deleteInviteOutboxByEmailAllTenantsInTx =
    overrides.outboxThrows !== undefined
      ? vi.fn(async () => {
          throw overrides.outboxThrows;
        })
      : vi.fn(async () => undefined);
  const appendInTx =
    overrides.auditThrows !== undefined
      ? vi.fn(async () => {
          throw overrides.auditThrows;
        })
      : vi.fn(async () => undefined);
  const deps: PruneExpiredInvitationsDeps = {
    users: {
      deletePendingInvitesExpiredBeforeInTx,
      deleteInviteOutboxByEmailAllTenantsInTx,
    } as unknown as PruneExpiredInvitationsDeps['users'],
    audit: { appendInTx } as unknown as PruneExpiredInvitationsDeps['audit'],
  };
  return {
    deps,
    deletePendingInvitesExpiredBeforeInTx,
    deleteInviteOutboxByEmailAllTenantsInTx,
    appendInTx,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('pruneExpiredInvitations', () => {
  it('happy path — 2 pruned rows: cleans outbox by email per row, audits invitation_expired per row, returns ok({prunedCount:2})', async () => {
    const { deps, deleteInviteOutboxByEmailAllTenantsInTx, appendInTx } = makeDeps({
      prunedRows: [
        { userId: USER_ID_1, email: 'stale-a@swecham.test' },
        { userId: USER_ID_2, email: 'stale-b@swecham.test' },
      ],
    });

    const result = await pruneExpiredInvitations(
      { now: new Date('2026-07-18T00:00:00.000Z'), requestId: 'req-prune-001' },
      deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ prunedCount: 2 });

    expect(deleteInviteOutboxByEmailAllTenantsInTx).toHaveBeenCalledTimes(2);
    expect(deleteInviteOutboxByEmailAllTenantsInTx).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'stale-a@swecham.test',
    );
    expect(deleteInviteOutboxByEmailAllTenantsInTx).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'stale-b@swecham.test',
    );

    expect(appendInTx).toHaveBeenCalledTimes(2);
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invitation_expired',
        actorUserId: 'system:cron',
        targetUserId: USER_ID_1,
        requestId: 'req-prune-001',
        summary: expect.stringContaining('stale-a@swecham.test'),
      }),
    );
    expect(appendInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'invitation_expired',
        actorUserId: 'system:cron',
        targetUserId: USER_ID_2,
        requestId: 'req-prune-001',
        summary: expect.stringContaining('stale-b@swecham.test'),
      }),
    );
  });

  it('no pruned rows — returns ok({prunedCount:0}), no outbox cleanup, no audit', async () => {
    const { deps, deleteInviteOutboxByEmailAllTenantsInTx, appendInTx } = makeDeps();

    const result = await pruneExpiredInvitations(
      { now: new Date('2026-07-18T00:00:00.000Z'), requestId: 'req-prune-002' },
      deps,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ prunedCount: 0 });
    expect(deleteInviteOutboxByEmailAllTenantsInTx).not.toHaveBeenCalled();
    expect(appendInTx).not.toHaveBeenCalled();
  });

  it('graceDays defaults to 30 — the cutoff passed to the repo is now minus 30*86_400_000ms', async () => {
    const { deps, deletePendingInvitesExpiredBeforeInTx } = makeDeps();
    const now = new Date('2026-07-18T12:00:00.000Z');

    await pruneExpiredInvitations({ now, requestId: 'req-prune-003' }, deps);

    const expectedCutoff = new Date(now.getTime() - 30 * 86_400_000);
    expect(deletePendingInvitesExpiredBeforeInTx).toHaveBeenCalledWith(
      expect.anything(),
      expectedCutoff,
    );
  });

  it('a caller-supplied graceDays overrides the 30-day default', async () => {
    const { deps, deletePendingInvitesExpiredBeforeInTx } = makeDeps();
    const now = new Date('2026-07-18T12:00:00.000Z');

    await pruneExpiredInvitations({ now, graceDays: 7, requestId: 'req-prune-004' }, deps);

    const expectedCutoff = new Date(now.getTime() - 7 * 86_400_000);
    expect(deletePendingInvitesExpiredBeforeInTx).toHaveBeenCalledWith(
      expect.anything(),
      expectedCutoff,
    );
  });

  it('atomicity: the outbox delete throws mid-batch → the error propagates out, is NOT swallowed, and the audit for that row is never reached', async () => {
    const boom = new Error('neon connection reset mid-delete');
    const { deps, appendInTx } = makeDeps({
      prunedRows: [{ userId: USER_ID_1, email: 'stale-a@swecham.test' }],
      outboxThrows: boom,
    });

    await expect(
      pruneExpiredInvitations(
        { now: new Date('2026-07-18T00:00:00.000Z'), requestId: 'req-prune-005' },
        deps,
      ),
    ).rejects.toThrow(boom);
    expect(appendInTx).not.toHaveBeenCalled();
  });

  it('atomicity: an audit append throws mid-batch → the error propagates out and is NOT swallowed', async () => {
    const boom = new Error('audit_log append-only trigger rejected the row');
    const { deps } = makeDeps({
      prunedRows: [{ userId: USER_ID_1, email: 'stale-a@swecham.test' }],
      auditThrows: boom,
    });

    await expect(
      pruneExpiredInvitations(
        { now: new Date('2026-07-18T00:00:00.000Z'), requestId: 'req-prune-006' },
        deps,
      ),
    ).rejects.toThrow(boom);
  });
});
