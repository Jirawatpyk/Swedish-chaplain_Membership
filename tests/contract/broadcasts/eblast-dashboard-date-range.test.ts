/**
 * F119 FR-030 — "The dashboard MUST be filterable by stage, member, and date
 * range" (contracts/dashboard-and-notifications.md § 1.1, Date range row).
 *
 * `fromDate` / `toDate` are the `YYYY-MM-DD` days the filter bar writes. They
 * bound `submitted_at`, as calendar days in the tenant's timezone (Asia/Bangkok
 * here): `fromDate` from its 00:00, `toDate` through the whole day — the list
 * is asked for `[00:00 of fromDate, 00:00 of the day after toDate)`. The date
 * filter used to reach the URL and stop there, so every range returned every
 * row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const row = (id: string, submittedAt: string | null) =>
  makeApprovalBroadcast({
    broadcastId: asBroadcastId(`11111111-1111-4111-8111-0000000000${id}`),
    status: 'submitted',
    submittedAt: submittedAt === null ? null : new Date(submittedAt),
  });

beforeEach(() => {
  resetDashboard();
  dash.rows = [
    row('01', '2026-03-09T16:59:59.999Z'), // 23:59:59.999 +07 on 03-09 — the day BEFORE fromDate
    row('02', '2026-03-09T17:00:00.000Z'), // 00:00 +07 on 03-10 — fromDate's first instant
    row('03', '2026-03-15T16:59:59.999Z'), // 23:59:59.999 +07 on 03-15 — toDate's last millisecond
    row('04', '2026-03-15T17:00:00.000Z'), // 00:00 +07 on 03-16 — the day AFTER toDate
    row('05', null), // never submitted
  ];
});

const idsOf = (body: Record<string, unknown>) =>
  (body['items'] as Array<Record<string, unknown>>).map((i) => (i['broadcastId'] as string).slice(-2));

describe('the date range narrows the dashboard (FR-030)', () => {
  it('a range keeps only rows submitted on those Bangkok calendar days, both end days whole', async () => {
    const { status, body } = await getQueue('?status=submitted&fromDate=2026-03-10&toDate=2026-03-15');
    expect(status).toBe(200);
    const opts = dash.listCalls.at(-1)!.opts;
    expect((opts['submittedFrom'] as Date).toISOString()).toBe('2026-03-09T17:00:00.000Z');
    expect((opts['submittedBefore'] as Date).toISOString()).toBe('2026-03-15T17:00:00.000Z');
    expect(idsOf(body)).toEqual(['02', '03']);
  });

  it('each side stands alone', async () => {
    const from = await getQueue('?status=submitted&fromDate=2026-03-10');
    expect(dash.listCalls.at(-1)!.opts['submittedBefore']).toBeUndefined();
    expect(idsOf(from.body)).toEqual(['02', '03', '04']);

    const to = await getQueue('?status=submitted&toDate=2026-03-15');
    expect(dash.listCalls.at(-1)!.opts['submittedFrom']).toBeUndefined();
    expect(idsOf(to.body)).toEqual(['01', '02', '03']);
  });

  it('no range → no bound, every row (the never-submitted one included)', async () => {
    const { body } = await getQueue('?status=submitted');
    const opts = dash.listCalls.at(-1)!.opts;
    expect(opts['submittedFrom']).toBeUndefined();
    expect(opts['submittedBefore']).toBeUndefined();
    expect(idsOf(body)).toEqual(['01', '02', '03', '04', '05']);
  });

  it.each([
    ['fromDate=2026-02-30'], // shape-valid, calendar-impossible
    ['toDate=2026-3-15'],
    ['fromDate=yesterday'],
  ])('%s is refused, never read as "no bound"', async (query) => {
    const { status } = await getQueue(`?status=submitted&${query}`);
    expect(status).toBe(400);
    expect(dash.listCalls).toEqual([]);
  });
});
