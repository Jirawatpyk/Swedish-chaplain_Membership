/**
 * `<QueueCardList>` — the admin review queue below `md`, drawn as board
 * `Admin-broadcasts-mobile` (spec 122 US12b, maintainer 18 Oct): one card per
 * row with a single full-width "Review" link to the detail page. No checkbox
 * (bulk approval lives on tablet and desktop) and no inline Approve / Reject
 * (they are one tap away on the detail page).
 *
 * The phone-width field set (FR-026) is pinned in
 * `queue-card-list-columns.test.tsx`.
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

function makeRow(overrides: Partial<EnrichedQueueRow> = {}): EnrichedQueueRow {
  return {
    broadcastId: 'b1',
    subject: 'Q3 Newsletter',
    memberDisplayName: 'Acme Co',
    actorRoleLabel: null,
    segmentLabel: 'All members',
    recipientCount: 42,
    ageBadge: null,
    statusTone: 'progress',
    statusBadgeLabel: 'Awaiting review',
    actionable: true,
    whoseTurnLabel: 'Marketing',
    timeInStageLabel: '3 h',
    round: 0,
    proposedSendAtFormatted: null,
    confirmedSendAtFormatted: null,
    lastActivityFormatted: '1 Aug 2026, 07:00',
    deliverySummary: null,
    ...overrides,
  };
}

function renderList(rows: ReadonlyArray<EnrichedQueueRow>, className?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <QueueCardList rows={rows} {...(className ? { className } : {})} />
    </NextIntlClientProvider>,
  );
}

describe('<QueueCardList>', () => {
  it('renders one card per row, named by its subject, inside a list', () => {
    renderList([
      makeRow({ broadcastId: 'b1', subject: 'First' }),
      makeRow({ broadcastId: 'b2', subject: 'Second' }),
    ]);
    const list = within(screen.getByTestId('queue-card-list'));
    expect(list.getByRole('list')).toBeInTheDocument();
    expect(list.getAllByRole('listitem')).toHaveLength(2);
    expect(list.getByRole('group', { name: 'First' })).toBeInTheDocument();
    expect(list.getByRole('group', { name: 'Second' })).toBeInTheDocument();
  });

  it('each card has one full-width Review link to the detail page, named for its subject', () => {
    renderList([makeRow({ broadcastId: 'b7', subject: 'Hello' })]);
    const card = within(screen.getByRole('group', { name: 'Hello' }));
    const links = card.getAllByRole('link');
    expect(links).toHaveLength(1);
    const review = card.getByRole('link', { name: 'Review Hello' });
    expect(review).toHaveAttribute('href', '/admin/broadcasts/b7');
    expect(review).toHaveTextContent('Review');
    expect(review).toHaveClass('aura-btn', 'aura-btn--secondary', 'aura-btn--full', 'aura-btn--touch');
  });

  it('has no checkbox and no inline Approve / Reject, even on an actionable row', () => {
    renderList([makeRow({ actionable: true })]);
    const list = within(screen.getByTestId('queue-card-list'));
    expect(list.queryByRole('checkbox')).toBeNull();
    expect(list.queryByRole('button')).toBeNull();
  });

  it('shows the member with the actor role when set', () => {
    renderList([makeRow({ memberDisplayName: 'Bob Lee', actorRoleLabel: 'Admin (proxy)' })]);
    expect(screen.getByText('Bob Lee · Admin (proxy)')).toBeInTheDocument();
  });

  it('shows the stage as an AURA status pill in the row tone', () => {
    renderList([makeRow({ statusTone: 'blocked', statusBadgeLabel: 'Rejected' })]);
    const pill = screen.getByText('Rejected').closest('.aura-pill');
    expect(pill).not.toBeNull();
    expect(pill).toHaveClass('aura-pill--blocked');
  });

  it('shows the SLA chip when the row is aging', () => {
    renderList([makeRow({ ageBadge: { label: '30 h waiting', variant: 'amber' } })]);
    expect(screen.getByText('30 h waiting')).toBeInTheDocument();
  });

  it('forwards className to the root element', () => {
    renderList([makeRow()], 'md:hidden');
    expect(screen.getByTestId('queue-card-list')).toHaveClass('md:hidden');
  });
});
