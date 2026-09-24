/**
 * F119 T112 (US4-AS4, US4-AS5, FR-028, FR-029, FR-036; contracts/
 * dashboard-and-notifications.md § 1.1 "Upcoming sends" and § 1.2 "Delivery
 * results").
 *
 *   - The Upcoming sends preset, `?status=approved&sort=scheduled_for&from=now`,
 *     asks the list for scheduled E-Blasts from now on, in send-time order.
 *     (The ORDER BY itself runs against live Postgres in
 *     `tests/integration/broadcasts/eblast-dashboard-pagination.test.ts`.)
 *   - A sent row carries recipients / delivered / bounced / complained from the
 *     existing `broadcast_deliveries` aggregate — read in ONE batch for the
 *     page, never per row — and a row that has not been sent carries none.
 *   - No contact-level data: not in the response, not in any statement the
 *     route issues (FR-036).
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

const SENT_ID = '11111111-1111-4111-8111-00000000000a';
const APPROVED_ID = '11111111-1111-4111-8111-00000000000b';

beforeEach(() => {
  resetDashboard();
});

describe('the Upcoming sends preset (T112, FR-028)', () => {
  it('the upcoming preset orders by `scheduled_for`', async () => {
    dash.rows = [makeApprovalBroadcast({ broadcastId: asBroadcastId(APPROVED_ID), status: 'approved' })];
    const before = Date.now();
    const { status } = await getQueue('?status=approved&sort=scheduled_for&from=now');
    const after = Date.now();
    expect(status).toBe(200);
    const opts = dash.listCalls.at(-1)!.opts;
    expect(opts['statusFilter']).toEqual(['approved']);
    expect(opts['sort']).toBe('scheduled_for_asc');
    const from = opts['scheduledFrom'];
    expect(from).toBeInstanceOf(Date);
    expect((from as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((from as Date).getTime()).toBeLessThanOrEqual(after);
  });

  // F119 round-4 B7 — the keyset pages on (`scheduled_for`, id), and without
  // the `from=now` bound a row with NO send time is in the list: its cursor key
  // is NULL, `(NULL, id) > (…)` is never true, so every unscheduled row after
  // page 1 silently vanished. The sort is the Upcoming preset's and nothing
  // else's — alone it is refused, before any read.
  it('`sort=scheduled_for` without `from=now` → 400 naming `sort`, nothing read', async () => {
    const { status, body } = await getQueue('?status=approved&sort=scheduled_for');
    expect(status).toBe(400);
    expect(body).toMatchObject({ error: { code: 'invalid_body', fieldErrors: { sort: [expect.any(String)] } } });
    expect(dash.listCalls).toHaveLength(0);
  });

  it('an unknown `from` value is refused, never read as "no bound"', async () => {
    const { status } = await getQueue('?status=approved&sort=scheduled_for&from=yesterday');
    expect(status).toBe(400);
  });
});

/**
 * UX review H1 — with no explicit `sort`, the list is ordered for the view it
 * is: longest in stage first when every stage in it is someone's turn, most
 * recent first otherwise (a Sent view must open on the latest sends, not the
 * 50 oldest). The page and this route share the one helper.
 */
describe('the default order follows the view (UX review H1)', () => {
  it.each([
    ['?status=submitted', 'stage_entered_at_asc'],
    ['?status=awaiting_member_approval&status=member_approved', 'stage_entered_at_asc'],
    ['?status=sent', 'stage_entered_at_desc'],
    ['?status=submitted&status=sent', 'stage_entered_at_desc'],
    ['?status=not_a_status', 'stage_entered_at_desc'],
  ])('%s → %s', async (query, sort) => {
    const { status } = await getQueue(query);
    expect(status).toBe(200);
    expect(dash.listCalls.at(-1)!.opts['sort']).toBe(sort);
  });

  it('an explicit sort still wins', async () => {
    await getQueue('?status=sent&sort=submitted_at_asc');
    expect(dash.listCalls.at(-1)!.opts['sort']).toBe('submitted_at_asc');
  });
});

describe('delivery results on sent rows (T112, FR-029, FR-036)', () => {
  it('a sent row carries the four counts and no recipient address', async () => {
    dash.rows = [
      makeApprovalBroadcast({ broadcastId: asBroadcastId(SENT_ID), status: 'sent' }),
      makeApprovalBroadcast({ broadcastId: asBroadcastId(APPROVED_ID), status: 'approved' }),
    ];
    dash.deliveries.set(SENT_ID, { recipients: 40, delivered: 37, bounced: 2, complained: 1 });
    const { status, body } = await getQueue('?status=sent&status=approved');
    expect(status).toBe(200);
    const items = body['items'] as Array<Record<string, unknown>>;
    const sent = items.find((i) => i['broadcastId'] === SENT_ID)!;
    const approved = items.find((i) => i['broadcastId'] === APPROVED_ID)!;
    expect(sent['delivery']).toEqual({ recipients: 40, delivered: 37, bounced: 2, complained: 1 });
    expect(approved['delivery']).toBeNull();

    // One batched read for the page, asked only for the rows that were sent.
    expect(dash.deliveryCalls).toEqual([[SENT_ID]]);

    // No contact-level data in the response: the fixture carries a reply-to and
    // a custom recipient address, and neither may surface.
    expect(JSON.stringify(body)).not.toContain('@');
    // …nor in any statement the route issued.
    for (const text of dash.sqlTexts) expect(text).not.toMatch(/email/i);
  });

  it('a page with no sent row does not read the aggregate at all', async () => {
    dash.rows = [makeApprovalBroadcast({ status: 'submitted' })];
    await getQueue('?status=submitted');
    expect(dash.deliveryCalls).toEqual([]);
  });
});
