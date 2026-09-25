/**
 * F119 T111 (US4-AS3, FR-027; contracts/dashboard-and-notifications.md § 1.2
 * "Stalled flag") — ONE comparison against `stage_entered_at`:
 *
 *   - marketing-held stages (Awaiting marketing review, In design, Changes
 *     requested, Member approved) are stalled at the 48 h review target
 *     (`SLA_RED_HOURS`);
 *   - the member-held stage (Awaiting member approval) is stalled at the
 *     3-day first-reminder threshold;
 *   - the 24 h amber level stays the PRE-WARNING it already is: it renders,
 *     but it is not labelled "Stalled", not counted, not announced.
 *
 * The flag is an icon AND a text label — never colour alone — and the label
 * is the badge's accessible name: the icon is `aria-hidden` and the badge (a
 * role-less span) carries NO `aria-label` (prohibited on a role-less element;
 * `check:strict-aria`).
 *
 * `QueueTable` is an async Server Component: resolve it, then render the
 * element (tests/unit/broadcast/queue-table-segment.test.tsx).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { stageOf } from '@/modules/broadcasts/domain/stage/broadcast-stage';
import { turnOf } from '@/modules/broadcasts/domain/stage/whose-turn';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: ns } as unknown as Parameters<
      typeof createTranslator
    >[0]),
  ),
  getLocale: vi.fn(async () => 'en'),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { QueueTable, type QueueRow } from '@/components/broadcast/admin/queue-table';
import { QueueWithBulk } from '@/components/broadcast/admin/queue-with-bulk';
import type { EnrichedQueueRow } from '@/components/broadcast/admin/queue-table-client';

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});
beforeEach(() => {
  vi.useRealTimers();
});
afterEach(cleanup);

const HOUR = 3_600_000;
/** `h` hours (and a minute) ago — the minute keeps a boundary row on the far side of it. */
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR - 60_000).toISOString();

function row(id: string, status: BroadcastStatus, hoursInStage: number): QueueRow {
  return {
    broadcastId: id,
    status,
    stage: stageOf(status),
    whoseTurn: turnOf(status),
    subject: `Subject ${id}`,
    requestedByMemberId: 'm1',
    requestedByMemberDisplayName: 'Acme Co',
    actorRole: 'member_self_service',
    segmentType: 'all_members',
    estimatedRecipientCount: 10,
    submittedAt: hoursAgo(hoursInStage),
    createdAt: hoursAgo(hoursInStage + 1),
    stageEnteredAt: hoursAgo(hoursInStage),
    currentRound: 1,
    proposedSendAt: null,
    confirmedSendAt: null,
    delivery: null,
  };
}

async function renderRows(rows: QueueRow[]) {
  const ui = await QueueTable({ rows, readOnly: true });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

const table = () => within(screen.getByRole('table'));

describe('the stalled flag (T111, FR-027)', () => {
  it("the accessible name reads 'Stalled — 3 days'; the icon is `aria-hidden`; no `aria-label` on a role-less span", async () => {
    await renderRows([row('m3', 'awaiting_member_approval', 3 * 24)]);
    const badge = table().getByText('Stalled — 3 days');
    expect(badge.tagName).toBe('SPAN');
    // The visible text IS the name: nothing overrides it, nothing else is read.
    expect(badge).not.toHaveAttribute('aria-label');
    expect(badge.getAttribute('role')).toBeNull();
    expect(badge.textContent?.trim()).toBe('Stalled — 3 days');
    const icon = badge.querySelector('svg');
    expect(icon).not.toBeNull();
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('a marketing-held stage is stalled at 48 h, in EVERY marketing-held stage — not only `submitted`', async () => {
    await renderRows([
      row('a', 'submitted', 49),
      row('b', 'in_design', 49),
      row('c', 'changes_requested', 49),
      row('d', 'member_approved', 49),
    ]);
    expect(table().getAllByText('Stalled — 2 days')).toHaveLength(4);
  });

  it('a member-held row short of 3 days is NOT stalled — its clock is the reminder threshold, not the 48 h review target', async () => {
    await renderRows([row('m2', 'awaiting_member_approval', 60)]);
    expect(table().queryByText(/Stalled/)).toBeNull();
    // …and no amber pre-warning on the member's clock either (the member has
    // 30 days; amber is the marketing review SLA's): the plain time in stage.
    expect(table().queryByText(/\d+ h waiting/)).toBeNull();
    expect(table().getByText('2 days')).toBeInTheDocument();
  });

  it('a 30 h marketing-held row renders amber but carries no stalled label and is absent from the stalled count', async () => {
    await renderRows([
      row('amber', 'in_design', 30),
      row('red', 'submitted', 50),
      row('member', 'awaiting_member_approval', 80),
    ]);
    // Amber: the existing pre-warning, re-based on time in stage.
    expect(table().getByText('30 h waiting')).toBeInTheDocument();
    expect(table().getAllByText(/^Stalled — /)).toHaveLength(2);
    // The stalled count names the two stalled rows, not the amber one — on
    // the rows shown (UX review H3: it is counted on this page, and says so).
    expect(screen.getByText('2 stalled shown')).toBeInTheDocument();
  });

  it('…and is never announced as stalled: the one live region counts only the stalled rows', async () => {
    const enriched = (id: string, ageBadge: EnrichedQueueRow['ageBadge']): EnrichedQueueRow => ({
      broadcastId: id,
      subject: `Subject ${id}`,
      memberDisplayName: 'Acme Co',
      actorRoleLabel: null,
      segmentLabel: 'All members',
      recipientCount: 10,
      ageBadge,
      statusBadgeVariant: 'secondary',
      statusBadgeLabel: 'In design',
      actionable: false,
      whoseTurnLabel: 'Marketing',
      timeInStageLabel: '30 h',
      round: 1,
      proposedSendAtFormatted: null,
      confirmedSendAtFormatted: null,
      lastActivityFormatted: '1 Aug 2026, 07:00',
      deliverySummary: null,
    });
    const labels = {
      member: 'Member',
      subject: 'Subject',
      audience: 'Audience',
      sendTime: 'Send time',
      status: 'Stage',
      whoseTurn: 'Whose turn',
      timeInStage: 'Time in stage',
      actions: 'Actions',
      select: 'Select broadcast',
      tableAria: 'Broadcast review queue',
    };
    const queue = (rows: EnrichedQueueRow[]) => (
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <QueueWithBulk rows={rows} readOnly columnLabels={labels} />
      </NextIntlClientProvider>
    );
    const { container, rerender } = render(queue([enriched('x', null)]));
    rerender(
      queue([
        enriched('amber', { label: '30 h waiting', variant: 'amber' }),
        enriched('red', { label: 'Stalled — 2 days', variant: 'red' }),
        enriched('none', null),
      ]),
    );
    const region = container.querySelector('[role="status"]');
    // No view total passed → "shown" (UX review H3); stalled counts only the red row.
    expect(region).toHaveTextContent('3 E-Blasts shown, 1 stalled shown');
  });

  it('a stage nobody is waiting on carries no age badge at all', async () => {
    await renderRows([row('s', 'approved', 400)]);
    expect(table().queryByText(/Stalled|waiting/)).toBeNull();
  });
});
