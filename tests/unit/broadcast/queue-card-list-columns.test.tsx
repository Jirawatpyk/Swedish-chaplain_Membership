/**
 * F119 T115 (FR-026; contracts/dashboard-and-notifications.md § 1.2 "At phone
 * width") — below `md` the card carries member, subject, stage, whose turn
 * and time in stage; round and the proposed / confirmed send times move to
 * the detail page. No horizontal scroll and no hidden-column menu: the card
 * is a stack of lines, never a squeezed table.
 *
 * Spec 122 US12b — the card follows board `Admin-broadcasts-mobile`: the last
 * activity date with the SLA chip, the subject, member, audience · recipient
 * count, then the stage pill and whose turn (kept for FR-026). UX review H2 —
 * FR-029's delivery results on a sent row. UX review M6 — the labels are
 * muted, the values are not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { QueueCardList } from '@/components/broadcast/admin/queue-card-list';
import type { EnrichedQueueRow } from '@/components/broadcast/admin/queue-table-client';

beforeEach(() => {
  vi.useRealTimers();
});

const ROW: EnrichedQueueRow = {
  broadcastId: 'b1',
  subject: 'Autumn gala',
  memberDisplayName: 'Acme Co',
  actorRoleLabel: null,
  segmentLabel: 'All members',
  recipientCount: 1042,
  ageBadge: { label: '30 h waiting', variant: 'amber' },
  statusTone: 'progress',
  statusBadgeLabel: 'Member approved — awaiting schedule',
  actionable: false,
  whoseTurnLabel: 'Marketing',
  timeInStageLabel: '30 h',
  round: 3,
  proposedSendAtFormatted: '1 Oct 2026, 10:00',
  confirmedSendAtFormatted: '2 Oct 2026, 11:00',
  lastActivityFormatted: '22 Sep 2026, 09:00',
  deliverySummary: null,
};

function renderList(rows: ReadonlyArray<EnrichedQueueRow>) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <QueueCardList rows={rows} />
    </NextIntlClientProvider>,
  );
}

describe('<QueueCardList> — the phone-width fields (T115, FR-026; board Admin-broadcasts-mobile)', () => {
  it('shows the last activity, the SLA chip, subject, member, audience and recipient count', () => {
    renderList([ROW]);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    expect(card.getByText('22 Sep 2026, 09:00')).toBeInTheDocument();
    expect(card.getByText('30 h waiting')).toBeInTheDocument();
    expect(card.getByText('Autumn gala')).toBeInTheDocument();
    expect(card.getByText('Acme Co')).toBeInTheDocument();
    expect(card.getByText('All members · 1,042 recipients')).toBeInTheDocument();
  });

  it('keeps the stage and whose turn on the card (FR-026)', () => {
    renderList([ROW]);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    expect(card.getByText('Member approved — awaiting schedule')).toBeInTheDocument();
    expect(card.getByText('Whose turn')).toBeInTheDocument();
    expect(card.getByText(/Marketing/)).toBeInTheDocument();
  });

  it('a waiting row with no SLA chip reads its time in stage as a labelled line', () => {
    renderList([{ ...ROW, ageBadge: null, timeInStageLabel: '3 h' }]);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    expect(card.getByText('Time in stage')).toBeInTheDocument();
    expect(card.getByText('3 h')).toBeInTheDocument();
  });

  it('a stage nobody is waiting on shows neither whose turn nor time in stage', () => {
    renderList([{ ...ROW, whoseTurnLabel: null, timeInStageLabel: null, ageBadge: null }]);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    expect(card.queryByText('Whose turn')).toBeNull();
    expect(card.queryByText('Time in stage')).toBeNull();
    expect(card.queryByText('—')).toBeNull();
  });

  it('a sent row carries its delivery results (FR-029, UX review H2); other rows carry none', () => {
    const summary = '40 recipients · 37 delivered · 2 bounced · 1 complained';
    renderList([
      { ...ROW, broadcastId: 'b-sent', subject: 'Sent one', deliverySummary: summary },
      { ...ROW, broadcastId: 'b-open', subject: 'Open one' },
    ]);
    expect(within(screen.getByRole('group', { name: 'Sent one' })).getByText(summary)).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: 'Open one' })).queryByText(/delivered/)).toBeNull();
  });

  it('the labels are muted and the values are not (UX review M6)', () => {
    renderList([{ ...ROW, ageBadge: null }]);
    const card = within(screen.getByRole('group', { name: 'Autumn gala' }));
    for (const label of ['Whose turn', 'Time in stage']) {
      expect(card.getByText(label)).toHaveClass('text-[var(--aura-fg-secondary)]');
    }
    expect(card.getByText('30 h')).not.toHaveClass('text-[var(--aura-fg-secondary)]');
  });

  it('round and both send times are absent below md', () => {
    renderList([ROW]);
    const list = within(screen.getByTestId('queue-card-list'));
    expect(list.queryByText(/Round/)).toBeNull();
    expect(list.queryByText(/Proposed/)).toBeNull();
    expect(list.queryByText(/Confirmed/)).toBeNull();
    expect(list.queryByText('1 Oct 2026, 10:00')).toBeNull();
    expect(list.queryByText('2 Oct 2026, 11:00')).toBeNull();
  });

  it('no squeezed table and no hidden-column menu inside the card list', () => {
    renderList([ROW]);
    const list = within(screen.getByTestId('queue-card-list'));
    expect(list.queryByRole('table')).toBeNull();
    expect(list.queryByRole('grid')).toBeNull();
    expect(list.queryByRole('menu')).toBeNull();
  });
});
