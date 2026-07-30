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
import { render, screen, within, cleanup } from '@testing-library/react';
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
  expiryLabel: '1 January 2027',
  refundSettling: false,
};

const MARKED: PendingReviewRow = {
  cycleId: '44444444-4444-4444-4444-444444444444',
  companyName: 'Rejected Co',
  memberId: 'member-rejected',
  memberNumberDisplay: 'SCCM-0043',
  pendingSinceLabel: '5 April 2026',
  expiryLabel: '1 January 2027',
  refundSettling: true,
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
      expiryLabel: '1 January 2027',
      refundSettling: false,
    };
    renderList([orphan]);
    // The fallback short-id renders as text, never as a /admin/members/ link.
    expect(
      screen.queryByRole('link', { name: '55555555' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('55555555')).toBeInTheDocument();
  });
});
