/**
 * UX-A Bug 2 — `<PendingReviewList>` marked-row rendering.
 *
 * A pending-review row whose cycle carries the async reject-with-refund marker
 * (`refundSettling: true`) is ALREADY decided (rejected; refund settling) and
 * only sits in this pending-status list until the reconcile cron converges it
 * to `cancelled`. It must render:
 *   - a distinct "Refund settling" status pill, and
 *   - a read-only "View" CTA (not "Review"),
 * so the queue doesn't overstate open review work. An UNMARKED row keeps the
 * "Review" CTA and shows no pill.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  render,
  screen,
  within,
  cleanup,
  fireEvent,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
  PendingReviewList,
  type PendingReviewRow,
} from '@/app/(staff)/admin/renewals/_components/pending-review-list';
import enMessages from '@/i18n/messages/en.json';

function renderList(rows: ReadonlyArray<PendingReviewRow>) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages as Record<string, unknown>}
    >
      <PendingReviewList rows={rows} />
    </NextIntlClientProvider>,
  );
}

const UNMARKED: PendingReviewRow = {
  cycleId: '33333333-3333-3333-3333-333333333333',
  companyName: 'Undecided Co',
  memberId: 'member-undecided',
  memberNumberDisplay: 'SCCM-0042',
  pendingSinceLabel: '1 April 2026',
  pendingSinceEpoch: Date.parse('2026-04-01T00:00:00.000Z'),
  expiryLabel: '1 January 2027',
  refundSettling: false,
  isAged: false,
  agingDays: 3,
};

const MARKED: PendingReviewRow = {
  cycleId: '44444444-4444-4444-4444-444444444444',
  companyName: 'Rejected Co',
  memberId: 'member-rejected',
  memberNumberDisplay: 'SCCM-0043',
  pendingSinceLabel: '5 April 2026',
  pendingSinceEpoch: Date.parse('2026-04-05T00:00:00.000Z'),
  expiryLabel: '1 January 2027',
  refundSettling: true,
  isAged: false,
  agingDays: 1,
};

describe('<PendingReviewList> — UX-A Bug 2 marked-row rendering', () => {
  afterEach(() => cleanup());

  it('renders a "Refund settling" pill only on the marked row', () => {
    renderList([UNMARKED, MARKED]);
    // Exactly one pill across the two rows.
    expect(screen.getAllByText('Refund settling')).toHaveLength(1);
    // The pill is inside the marked row's cell (next to "Rejected Co").
    const markedRow = screen.getByText('Rejected Co').closest('tr');
    expect(markedRow).not.toBeNull();
    expect(
      within(markedRow as HTMLElement).getByText('Refund settling'),
    ).toBeInTheDocument();
    // The unmarked row shows no pill.
    const unmarkedRow = screen.getByText('Undecided Co').closest('tr');
    expect(
      within(unmarkedRow as HTMLElement).queryByText('Refund settling'),
    ).not.toBeInTheDocument();
  });

  it('uses the read-only "View" CTA for a marked row and "Review" for an unmarked row', () => {
    renderList([UNMARKED, MARKED]);
    const markedRow = screen.getByText('Rejected Co').closest('tr');
    const unmarkedRow = screen.getByText('Undecided Co').closest('tr');
    expect(
      within(markedRow as HTMLElement).getByRole('link', { name: 'View' }),
    ).toBeInTheDocument();
    expect(
      within(markedRow as HTMLElement).queryByRole('link', { name: 'Review' }),
    ).not.toBeInTheDocument();
    expect(
      within(unmarkedRow as HTMLElement).getByRole('link', { name: 'Review' }),
    ).toBeInTheDocument();
  });
});

describe('<PendingReviewList> — B4 member link + SCCM cell', () => {
  afterEach(() => cleanup());

  it('renders the company as a member link with the SCCM number when memberId is present', () => {
    renderList([UNMARKED]);
    const link = screen.getByRole('link', { name: 'Undecided Co' });
    expect(link).toHaveAttribute('href', '/admin/members/member-undecided');
    // SCCM number shows in muted secondary text next to the company link.
    expect(screen.getByText('SCCM-0042')).toBeInTheDocument();
  });

  it('renders the company as plain text (no link, no SCCM) when memberId is absent', () => {
    const orphan: PendingReviewRow = {
      cycleId: '55555555-5555-5555-5555-555555555555',
      companyName: '55555555',
      memberId: null,
      memberNumberDisplay: null,
      pendingSinceLabel: '1 April 2026',
      pendingSinceEpoch: Date.parse('2026-04-01T00:00:00.000Z'),
      expiryLabel: '1 January 2027',
      refundSettling: false,
      isAged: false,
      agingDays: 0,
    };
    renderList([orphan]);
    // The fallback short-id renders as text, never as a /admin/members/ link.
    expect(
      screen.queryByRole('link', { name: '55555555' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('55555555')).toBeInTheDocument();
  });
});

describe('<PendingReviewList> — B3 aging chip + sortable "Pending since"', () => {
  afterEach(() => cleanup());

  const OLDER: PendingReviewRow = {
    cycleId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    companyName: 'Older Co',
    memberId: 'member-older',
    memberNumberDisplay: 'SCCM-0100',
    pendingSinceLabel: '1 March 2026',
    pendingSinceEpoch: Date.parse('2026-03-01T00:00:00.000Z'),
    expiryLabel: '1 January 2027',
    refundSettling: false,
    isAged: true,
    agingDays: 9,
  };
  const NEWER: PendingReviewRow = {
    cycleId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    companyName: 'Newer Co',
    memberId: 'member-newer',
    memberNumberDisplay: 'SCCM-0200',
    pendingSinceLabel: '20 April 2026',
    pendingSinceEpoch: Date.parse('2026-04-20T00:00:00.000Z'),
    expiryLabel: '1 January 2027',
    refundSettling: false,
    isAged: false,
    agingDays: 2,
  };

  function companyOrder(): string[] {
    return screen
      .getAllByRole('row')
      // drop the header row (has no data cells with company links)
      .slice(1)
      .map((tr) => within(tr).getByRole('link', { name: /Co$/ }).textContent!);
  }

  it('defaults to oldest-first so the most-aged row leads', () => {
    // Pass NEWER first to prove the component sorts (not just preserves input).
    renderList([NEWER, OLDER]);
    expect(companyOrder()).toEqual(['Older Co', 'Newer Co']);
  });

  it('toggles to newest-first when the header button is clicked', () => {
    renderList([NEWER, OLDER]);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Sort by pending since, newest first',
      }),
    );
    expect(companyOrder()).toEqual(['Newer Co', 'Older Co']);
  });

  it('marks the columnheader aria-sort state (ascending by default)', () => {
    renderList([NEWER, OLDER]);
    const header = screen
      .getByRole('button', { name: 'Sort by pending since, newest first' })
      .closest('th');
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  it('renders the amber "Aged {n}d" chip only on an aged row', () => {
    renderList([OLDER, NEWER]);
    expect(screen.getByText('Aged 9d')).toBeInTheDocument();
    // NEWER is not aged → no chip for it.
    const newerRow = screen.getByText('Newer Co').closest('tr');
    expect(
      within(newerRow as HTMLElement).queryByText(/^Aged/),
    ).not.toBeInTheDocument();
  });
});
