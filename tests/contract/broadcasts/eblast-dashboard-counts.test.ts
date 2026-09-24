/**
 * F119 T109 (US4-AS1, FR-025; contracts/dashboard-and-notifications.md § 1.1)
 * — `GET /api/admin/broadcasts` carries a count per stage, and selecting a
 * stage filters the list to it.
 *
 * The counts come from one grouped read (`BroadcastQueueReads.countByStatus`)
 * and are zero-filled over EVERY status, so a stage with no rows reads 0
 * rather than being absent (a missing key would render as "no count" and
 * could not be told from a failed read). The live-Neon half — the grouped
 * read against 1,000 seeded rows — is `eblast-dashboard-pagination.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BROADCAST_STATUSES } from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { makeApprovalBroadcast } from '../../helpers/eblast-approval-fakes';
import { dash, getQueue, resetDashboard } from '../../helpers/eblast-dashboard-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-dashboard-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-dashboard-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-dashboard-route-harness')).loggerMock());
vi.mock('@/lib/db', async () => (await import('../../helpers/eblast-dashboard-route-harness')).dbMock());
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-dashboard-route-harness')).broadcastsBarrelMock(),
);

/** One row per seeded stage, with the count the grouped read reports for it. */
const SEEDED = {
  submitted: 4,
  in_design: 2,
  awaiting_member_approval: 3,
  changes_requested: 1,
  member_approved: 1,
  approved: 5,
  sent: 7,
  expired_no_member_response: 2,
} as const;

beforeEach(() => {
  resetDashboard();
  dash.counts = { ...SEEDED };
  dash.rows = Object.keys(SEEDED).map((status, i) =>
    makeApprovalBroadcast({
      broadcastId: asBroadcastId(`00000000-0000-4000-8000-00000000000${i}`),
      status: status as keyof typeof SEEDED,
    }),
  );
});

describe('GET /api/admin/broadcasts — a count per stage (T109)', () => {
  it('counts match seeded rows per stage, zero-filled over every status', async () => {
    const { status, body } = await getQueue('?status=submitted');
    expect(status).toBe(200);
    const counts = body['stageCounts'] as Record<string, number>;
    expect(Object.keys(counts).sort()).toEqual([...BROADCAST_STATUSES].sort());
    for (const s of BROADCAST_STATUSES) {
      expect(counts[s], s).toBe((SEEDED as Record<string, number>)[s] ?? 0);
    }
  });

  it('selecting a stage filters the list to it — the repo is asked for that stage only, and only its rows come back', async () => {
    const { body } = await getQueue('?status=awaiting_member_approval');
    expect(dash.listCalls.at(-1)?.opts['statusFilter']).toEqual(['awaiting_member_approval']);
    const items = body['items'] as Array<{ status: string }>;
    expect(items.map((i) => i.status)).toEqual(['awaiting_member_approval']);
  });

  it('the counts do not depend on the stage selected — every chip keeps its number while one is active', async () => {
    const a = (await getQueue('?status=sent')).body['stageCounts'];
    const b = (await getQueue('?status=in_design')).body['stageCounts'];
    expect(a).toEqual(b);
  });
});
