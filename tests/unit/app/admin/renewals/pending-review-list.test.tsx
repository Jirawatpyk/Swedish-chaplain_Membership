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
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  render,
  screen,
  within,
  cleanup,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
  PendingReviewList,
  type PendingReviewRow,
} from '@/app/(staff)/admin/renewals/_components/pending-review-list';
import enMessages from '@/i18n/messages/en.json';

// B2 — the component calls `useRouter()` for the post-approve refresh. The
// approve dialog is the real AURA one (122 US7a T707): no primitive mocks.
const refreshMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/lib/toast', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));
function renderList(
  rows: ReadonlyArray<PendingReviewRow>,
  props?: { canApprove?: boolean },
) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages as Record<string, unknown>}
    >
      {/* The real staff layout provides `<main id="main-content" tabIndex={-1}>`
          as the focus-return landmark; mirror it so the finalFocus resolver's
          `document.getElementById('main-content')` fallback resolves. */}
      <main id="main-content" tabIndex={-1} />
      <PendingReviewList rows={rows} canApprove={props?.canApprove ?? false} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  // Component tests: the shared setup installs fake timers, which freezes
  // `waitFor` into a test-timeout hang. Reset to real timers per test.
  vi.useRealTimers();
  refreshMock.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

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

describe('<PendingReviewList> — B2 inline Approve', () => {
  afterEach(() => cleanup());

  const APPROVE_TRIGGER = 'Approve reactivation for Undecided Co';

  it('renders an inline Approve + Review for an OPEN row when canApprove', () => {
    renderList([UNMARKED], { canApprove: true });
    expect(
      screen.getByRole('button', { name: APPROVE_TRIGGER }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
  });

  it('renders no Approve for a read-only viewer (canApprove false)', () => {
    renderList([UNMARKED]);
    expect(
      screen.queryByRole('button', { name: /^Approve/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review' })).toBeInTheDocument();
  });

  it('renders View only (no Approve) for a refund-settling row even when canApprove', () => {
    renderList([MARKED], { canApprove: true });
    expect(
      screen.queryByRole('button', { name: /^Approve reactivation for/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View' })).toBeInTheDocument();
  });

  it('returns focus to #main-content after a successful approve (the row\'s trigger leaves the list)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderList([UNMARKED], { canApprove: true });
      fireEvent.click(screen.getByRole('button', { name: APPROVE_TRIGGER }));
      const dialog = screen.getByRole('alertdialog', { name: 'Approve this reactivation?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      expect(refreshMock).toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      await waitFor(() => expect(document.activeElement).toBe(document.getElementById('main-content')));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('approves inline: POSTs the reactivate route and toasts success', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderList([UNMARKED], { canApprove: true });
      fireEvent.click(screen.getByRole('button', { name: APPROVE_TRIGGER }));
      // Confirm in the dialog — "Approve" = reactivate.confirm.
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/admin/renewals/${encodeURIComponent(UNMARKED.cycleId)}/reactivate`,
        expect.objectContaining({ method: 'POST' }),
      );
      await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
      expect(refreshMock).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the row on a failed approve (generic error toasts, row stays)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { code: 'server_error' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderList([UNMARKED], { canApprove: true });
      fireEvent.click(screen.getByRole('button', { name: APPROVE_TRIGGER }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Approve' }));
      await waitFor(() => expect(toastError).toHaveBeenCalled());
      expect(toastSuccess).not.toHaveBeenCalled();
      // No refresh — the cycle stays pending, so the row (Approve trigger) remains.
      expect(refreshMock).not.toHaveBeenCalled();
      expect(
        screen.getByRole('button', { name: APPROVE_TRIGGER }),
      ).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('closes the dialog on a 409 reject_refund_in_progress: specific toast, refresh, and finalFocus returns #main-content (opposite of the generic-error keep-row path)', async () => {
    // A 409 means the cycle was rejected (async refund in flight) between render
    // and click. Unlike the generic-500 path (dialog stays open, row survives),
    // the component fires the SPECIFIC reject-in-progress toast, raises
    // `closedViaSuccessRef`, closes the dialog, and refreshes so the row
    // re-renders into the settling (read-only) state.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'reject_refund_in_progress' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderList([UNMARKED], { canApprove: true });
      fireEvent.click(screen.getByRole('button', { name: APPROVE_TRIGGER }));
      const dialog = screen.getByRole('alertdialog', { name: 'Approve this reactivation?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Approve' }));

      // The SPECIFIC reject-in-progress toast fires — NOT the generic
      // "Couldn't approve" copy (proves the 409 branch, not the fallthrough).
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          'This reactivation was already rejected — a refund is settling, so it can no longer be approved.',
        ),
      );
      expect(toastSuccess).not.toHaveBeenCalled();

      // The dialog CLOSES and the page refreshes so the row re-renders read-only.
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
      expect(refreshMock).toHaveBeenCalled();

      // `closedViaSuccessRef` was raised on the 409 close path, so focus skips
      // the vanishing Approve trigger and lands on #main-content (WCAG 2.4.3).
      await waitFor(() => expect(document.activeElement).toBe(document.getElementById('main-content')));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// 122 US7a (T707): the list on AURA — a table that stacks on a phone, the
// settling and aged chips as AURA badges, Approve and Review as AURA
// buttons, and the Approve confirmation as an AURA alertdialog.
describe('<PendingReviewList> on AURA', () => {
  afterEach(() => cleanup());

  it('renders an AURA table with AURA badges for the settling and aged chips', () => {
    renderList([UNMARKED, MARKED, { ...UNMARKED, cycleId: 'c-aged', companyName: 'Aged Co', memberId: 'm-aged', isAged: true, agingDays: 9 }]);
    expect(screen.getByRole('table').closest('.aura-tbl')).not.toBeNull();
    expect(screen.getByText('Refund settling').closest('.aura-badge')).not.toBeNull();
    expect(screen.getByText('Aged 9d').closest('.aura-badge')).not.toBeNull();
  });

  it('Approve and Review are AURA buttons; Approve opens an AURA alertdialog', () => {
    renderList([UNMARKED], { canApprove: true });
    const approve = screen.getByRole('button', { name: 'Approve reactivation for Undecided Co' });
    expect(approve).toHaveClass('aura-btn');
    expect(screen.getByRole('link', { name: 'Review' })).toHaveClass('aura-btn', 'aura-btn--secondary');
    fireEvent.click(approve);
    expect(screen.getByRole('alertdialog', { name: 'Approve this reactivation?' })).toHaveClass('aura-dialog');
  });

  it('the empty list is an AURA empty state', () => {
    renderList([]);
    expect(screen.getByText('Nothing awaiting review').closest('.aura-empty')).not.toBeNull();
  });
});
