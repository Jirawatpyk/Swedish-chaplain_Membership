/**
 * 126 (#2) — bulk archive runs the single `archiveMember` cascade.
 *
 * Before 126 the bulk `archive` arm wrote only status + `member_archived`.
 * The single archive also revokes every linked portal user's sessions,
 * soft-consumes their pending invitations (in the same tx) and, after the
 * commit, cancels in-flight broadcasts and the member's renewal cycle. The
 * portal has no archived-status guard, so a bulk-archived member's users
 * stayed signed in and their renewal cycle kept sending reminders.
 *
 * Because bulk archive now cancels the cycle, its Undo (bulk `unarchive`)
 * must restore one — the same post-commit `restoreForMember` the single
 * undelete runs.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const runInTenantMock = vi.fn();
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: (...a: unknown[]) => runInTenantMock(...a),
}));

import { bulkAction, type BulkActionDeps } from '@/modules/members/application/use-cases/bulk-action';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const M1 = asMemberId('11111111-1111-4111-8111-111111111111');
const M2 = asMemberId('22222222-2222-4222-8222-222222222222');
const META = { actorUserId: 'admin-1', requestId: 'req-126' };

const events: string[] = [];

function row(id: string, status: 'active' | 'archived') {
  return {
    tenantId: 'test-tenant',
    memberId: id,
    status,
    archivedAt: status === 'archived' ? new Date(Date.now() - 86_400_000) : null,
  };
}

function makeDeps(rows: ReturnType<typeof row>[]) {
  const map = new Map(rows.map((r) => [r.memberId, r]));
  const deps = {
    tenant,
    clock: { now: () => new Date() },
    memberRepo: {
      findManyByIdsInTx: vi.fn(async () => ok(map)),
      updateStatusInTx: vi.fn(async (_tx: unknown, id: string) => ok(map.get(id))),
      findErasedIdsInTx: vi.fn(async () => ok(new Set())),
      findIdsWithoutLivePrimaryInTx: vi.fn(async () => ok(new Set())),
    },
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn(async (_tx: unknown, _t: unknown, e: { type: string }) => {
        events.push(`audit:${e.type}`);
        return ok(undefined);
      }),
    },
    contactRepo: {
      listLinkedUserIdsForMemberInTx: vi.fn(async (_tx: unknown, id: string) =>
        id === M1 ? ['user-a', 'user-a', 'user-b'] : [],
      ),
    },
    sessions: {
      revokeAllForInTx: vi.fn(async (_tx: unknown, userId: string) => {
        events.push(`revoke:${userId}`);
        return ok({ revokedCount: 2 });
      }),
    },
    invitations: {
      softConsumePendingForUsersInTx: vi.fn(async () => ({ revokedCount: 1 })),
    },
    broadcastsCascade: {
      cancelInFlightForMember: vi.fn(async (_t: unknown, id: string) => {
        events.push(`broadcasts:${id}`);
        return { outcome: 'ok', cancelledCount: 0 };
      }),
    },
    renewalsCascade: {
      cancelInFlightForMember: vi.fn(async (_t: unknown, id: string) => {
        events.push(`cycle-cancel:${id}`);
        return { outcome: 'ok', cancelledCount: 1 };
      }),
      restoreForMember: vi.fn(async (_t: unknown, id: string) => {
        events.push(`cycle-restore:${id}`);
        return { outcome: 'restored', cycleId: 'c1' };
      }),
    },
  };
  return deps as unknown as BulkActionDeps & typeof deps;
}

describe('bulkAction archive — single-archive cascade (126 #2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    runInTenantMock.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
      const out = await fn({ __tx: true });
      events.push('commit');
      return out;
    });
  });

  it('revokes the sessions of each unique linked user inside the tx', async () => {
    const deps = makeDeps([row(M1, 'active'), row(M2, 'active')]);
    const r = await bulkAction({ action: 'archive', member_ids: [M1, M2] }, META, deps);
    expect(r.ok).toBe(true);
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledTimes(2);
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledWith({ __tx: true }, 'user-a', 'admin_force');
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledWith({ __tx: true }, 'user-b', 'admin_force');
    expect(events.indexOf('revoke:user-a')).toBeLessThan(events.indexOf('commit'));
    expect(events.filter((e) => e === 'audit:user_sessions_revoked')).toHaveLength(2);
    expect(deps.invitations.softConsumePendingForUsersInTx).toHaveBeenCalledWith(
      { __tx: true },
      ['user-a', 'user-b'],
      expect.any(Date),
    );
  });

  it('cancels each member renewal cycle and in-flight broadcasts after the commit', async () => {
    const deps = makeDeps([row(M1, 'active'), row(M2, 'active')]);
    await bulkAction({ action: 'archive', member_ids: [M1, M2] }, META, deps);
    const commitAt = events.indexOf('commit');
    expect(events.indexOf(`cycle-cancel:${M1}`)).toBeGreaterThan(commitAt);
    expect(events.indexOf(`cycle-cancel:${M2}`)).toBeGreaterThan(commitAt);
    expect(events.indexOf(`broadcasts:${M1}`)).toBeGreaterThan(commitAt);
  });

  it('a failed post-commit cascade does not fail the committed archive', async () => {
    const deps = makeDeps([row(M1, 'active')]);
    deps.renewalsCascade.cancelInFlightForMember.mockRejectedValueOnce(new Error('f8 down'));
    const r = await bulkAction({ action: 'archive', member_ids: [M1] }, META, deps);
    expect(r.ok).toBe(true);
  });

  it('bulk unarchive (the Undo) restores a renewal cycle per member after the commit', async () => {
    const deps = makeDeps([row(M1, 'archived'), row(M2, 'archived')]);
    const r = await bulkAction({ action: 'unarchive', member_ids: [M1, M2] }, META, deps);
    expect(r.ok).toBe(true);
    const commitAt = events.indexOf('commit');
    expect(events.indexOf(`cycle-restore:${M1}`)).toBeGreaterThan(commitAt);
    expect(events.indexOf(`cycle-restore:${M2}`)).toBeGreaterThan(commitAt);
  });
});
