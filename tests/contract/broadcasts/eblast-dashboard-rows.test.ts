/**
 * F119 T110 (US4-AS2, FR-026, FR-031; contracts/dashboard-and-notifications.md
 * § 1.2, data-model § 8.1 / 8.1b) — every row of `GET /api/admin/broadcasts`
 * carries member, subject, stage, whose turn, time in stage, round, proposed
 * and confirmed send times and last activity.
 *
 *   - `whoseTurn` is `'marketing'` for Awaiting marketing review / In design /
 *     Changes requested / Member approved, `'member'` for Awaiting member
 *     approval, and `null` ("—") for Draft, Scheduled, Sending and every closed
 *     or historical stage. There is no `'system'` value.
 *   - Time in stage and last activity both read `stage_entered_at`.
 *   - The round is the stored `current_round` — the count of versions SENT to
 *     the member — never a count of decisions: a withdrawn approval leaves it
 *     where it was, the next send moves it. (The column's writes are pinned in
 *     the send / decision use-case suites; this pins that the dashboard reads
 *     the column and nothing else.)
 *   - The confirmed send time exists only once marketing confirmed it
 *     (Scheduled onwards); before that `scheduled_for` is still the member's
 *     proposal and must not be shown as confirmed.
 *   - `expired_no_member_response` is a CLOSED stage: it groups under
 *     "Closed", never "In review" (/speckit.analyze H4).
 *   - A proxy-submitted E-Blast is listed with the same columns (FR-031).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  BROADCAST_STATUSES,
  TERMINAL_BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';
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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/broadcasts',
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `NextIntlClientProvider` typed with OPTIONAL children, so this `.ts` file can
 * pass them as `createElement`'s third argument (its props type requires them,
 * and `react/no-children-prop` forbids passing them as a prop).
 */
const IntlProvider = NextIntlClientProvider as unknown as (props: {
  locale: string;
  messages: typeof enMessages;
  children?: React.ReactNode;
}) => React.ReactElement;

/** Written out by hand from FR-026 — NOT derived from `turnOf`, or the test would agree with any bug in it. */
const EXPECTED_TURN: Readonly<Record<BroadcastStatus, 'marketing' | 'member' | null>> = {
  draft: null,
  submitted: 'marketing',
  in_design: 'marketing',
  awaiting_member_approval: 'member',
  changes_requested: 'marketing',
  member_approved: 'marketing',
  approved: null,
  sending: null,
  sent: null,
  rejected: null,
  cancelled: null,
  expired_no_member_response: null,
  failed_to_dispatch: null,
  partially_sent: null,
  partial_delivery_accepted: null,
};

const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const STAGE_ENTERED = new Date('2026-09-21T02:00:00.000Z');
const PROPOSED = new Date('2026-10-01T03:00:00.000Z');
const CONFIRMED = new Date('2026-10-02T04:00:00.000Z');

type Item = Record<string, unknown>;

async function onlyItem(): Promise<Item> {
  const { status, body } = await getQueue('?status=' + String(dash.rows[0]!.status));
  expect(status).toBe(200);
  const items = body['items'] as Item[];
  expect(items).toHaveLength(1);
  return items[0]!;
}

beforeEach(() => {
  resetDashboard();
  dash.memberNames.set(MEMBER_ID, 'Acme Co');
});

describe('every dashboard row carries the FR-026 columns (T110)', () => {
  it('member, subject, stage, whose turn, time in stage / last activity, round, proposed and confirmed send times', async () => {
    dash.rows = [
      makeApprovalBroadcast({
        status: 'approved',
        subject: 'Autumn gala',
        currentRound: 2,
        stageEnteredAt: STAGE_ENTERED,
        proposedSendAt: PROPOSED,
        scheduledFor: CONFIRMED,
      }),
    ];
    const item = await onlyItem();
    expect(item).toMatchObject({
      requestedByMemberDisplayName: 'Acme Co',
      subject: 'Autumn gala',
      status: 'approved',
      stage: 'scheduled',
      whoseTurn: null,
      stageEnteredAt: STAGE_ENTERED.toISOString(),
      currentRound: 2,
      proposedSendAt: PROPOSED.toISOString(),
      confirmedSendAt: CONFIRMED.toISOString(),
    });
  });

  it.each(BROADCAST_STATUSES)('whoseTurn is correct for every status — %s', async (status) => {
    dash.rows = [makeApprovalBroadcast({ status })];
    const item = await onlyItem();
    expect(item['whoseTurn']).toBe(EXPECTED_TURN[status]);
    expect(item['whoseTurn']).not.toBe('system');
  });

  it('before marketing confirms, scheduled_for is still the proposal — no confirmed send time is shown', async () => {
    dash.rows = [makeApprovalBroadcast({ status: 'member_approved', proposedSendAt: PROPOSED, scheduledFor: PROPOSED })];
    const item = await onlyItem();
    expect(item['proposedSendAt']).toBe(PROPOSED.toISOString());
    expect(item['confirmedSendAt']).toBeNull();
  });

  it('a pre-0308 row with no recorded proposal reads null, not the confirmed time', async () => {
    dash.rows = [makeApprovalBroadcast({ status: 'sent', proposedSendAt: null, scheduledFor: CONFIRMED })];
    const item = await onlyItem();
    expect(item['proposedSendAt']).toBeNull();
    expect(item['confirmedSendAt']).toBe(CONFIRMED.toISOString());
  });

  it('the round does not move on a withdrawn approval and does move on the next send', async () => {
    // Round 1 approved, then the member withdraws the approval: → changes_requested,
    // `current_round` untouched (record-member-decision.ts writes no round).
    dash.rows = [makeApprovalBroadcast({ status: 'changes_requested', currentRound: 1 })];
    expect((await onlyItem())['currentRound']).toBe(1);
    // Marketing sends the next version: → awaiting_member_approval, current_round = 2.
    dash.rows = [makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 2 })];
    expect((await onlyItem())['currentRound']).toBe(2);
  });

  it('a proxy-submitted E-Blast (staff submitted on the member\'s behalf) appears in the list with the same columns as a member-submitted one', async () => {
    dash.rows = [
      makeApprovalBroadcast({ broadcastId: asBroadcastId('11111111-1111-4111-8111-000000000001'), actorRole: 'member_self_service' }),
      makeApprovalBroadcast({ broadcastId: asBroadcastId('11111111-1111-4111-8111-000000000002'), actorRole: 'admin_proxy' }),
    ];
    const { body } = await getQueue('?status=submitted');
    const items = body['items'] as Item[];
    expect(items).toHaveLength(2);
    const [member, proxy] = items as [Item, Item];
    expect(proxy['actorRole']).toBe('admin_proxy');
    expect(Object.keys(proxy).sort()).toEqual(Object.keys(member).sort());
    expect(proxy).toMatchObject({ stage: 'awaiting_marketing_review', whoseTurn: 'marketing' });
  });
});

describe('`expired_no_member_response` is a closed stage (T110, /speckit.analyze H4)', () => {
  it('`expired_no_member_response` groups under Closed, never under In review — it is in `TERMINAL_BROADCAST_STATUSES` and its `whoseTurn` is null', async () => {
    expect(TERMINAL_BROADCAST_STATUSES).toContain('expired_no_member_response');
    dash.rows = [makeApprovalBroadcast({ status: 'expired_no_member_response' })];
    expect((await onlyItem())['whoseTurn']).toBeNull();

    const { QueueFilters } = await import('@/components/broadcast/admin/queue-filters');
    render(
      createElement(
        IntlProvider,
        { locale: 'en', messages: enMessages },
        createElement(QueueFilters, { memberOptions: [], stageCounts: null, approvalRoundEnabled: true }),
      ),
    );
    const valuesIn = (name: RegExp) =>
      within(screen.getByRole('group', { name }))
        .getAllByRole('checkbox')
        .map((el) => (el as HTMLInputElement).value);
    const inReview = valuesIn(/in review/i);
    const closed = valuesIn(/closed/i);
    expect(closed).toContain('expired_no_member_response');
    expect(inReview).not.toContain('expired_no_member_response');
    // …and the four in-progress new stages are the ones that joined "In review".
    for (const s of ['in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved']) {
      expect(inReview, s).toContain(s);
      expect(closed, s).not.toContain(s);
    }
  });
});
