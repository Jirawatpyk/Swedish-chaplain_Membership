/**
 * Spec 122 US9a (T904) — the attendees table on AURA (board
 * `Admin-event-detail`, docs/aura-adoption.md § Filters):
 *
 * - AURA FilterBar: the search, the "Show unmatched only" toggle chip and a
 *   compact payment-status `FilterSelect`; each writes today's URL parameter
 *   (`q`, `unmatchedOnly`, `paymentStatus`) and drops `page`, in place.
 * - The count is the bar's polite live region.
 * - The AURA table: Attendee, Match, Ticket, Quota, Registered, Actions, the
 *   match and quota badges in the board's tones.
 * - The filtered-empty state keeps "Clear filters" (toast, then the search
 *   takes focus).
 *
 * The erase and payment-status guards keep their own tests
 * (tests/unit/events/attendee-table-*-guard.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { AttendeeRow } from '@/components/events/attendee-table';
import { asEventId } from '@/modules/events/domain/branded-types';

const nav = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn(), search: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: vi.fn(), replace: nav.replace }),
  usePathname: () => '/admin/events/e1',
  useSearchParams: () => nav.search.current,
}));
const toastMock = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toastMock }));

const { AttendeeTable } = await import('@/components/events/attendee-table');

const a = en.admin.events.detail.attendees;
const EVENT_ID = asEventId('00000000-0000-4000-8000-000000000001');

function row(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    registrationId: 'reg-1' as AttendeeRow['registrationId'],
    attendeeEmail: 'erik@siamnordic.example' as AttendeeRow['attendeeEmail'],
    attendeeName: 'Erik Johansson',
    attendeeCompany: 'Siam Nordic Trading Co., Ltd.',
    matchType: 'member_contact',
    ticketType: 'Member ticket',
    ticketPriceThb: null,
    paymentStatus: 'paid',
    countedAgainstPartnership: false,
    countedAgainstCulturalQuota: true,
    isOverQuota: false,
    registeredAt: '2026-08-12T03:14:00Z',
    currentMatchedMemberId: null,
    isPseudonymised: false,
    ...overrides,
  };
}

function renderTable(props: Partial<Parameters<typeof AttendeeTable>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AttendeeTable
        rows={[row()]}
        unmatchedOnly={false}
        initialSearch=""
        eventId={EVENT_ID}
        canRelink
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  nav.replace.mockReset();
  nav.push.mockReset();
  nav.search.current = new URLSearchParams();
  vi.clearAllMocks();
});

describe('attendee filters (AURA FilterBar)', () => {
  it('writes the search to `q`, dropping the page, in place', () => {
    nav.search.current = new URLSearchParams('page=2');
    renderTable();
    const box = screen.getByRole('searchbox', { name: a.searchLabel });
    fireEvent.change(box, { target: { value: 'erik' } });
    act(() => vi.runOnlyPendingTimers());
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events/e1?q=erik', { scroll: false });
  });

  it('toggles "Show unmatched only" as a pressed chip writing `unmatchedOnly`', () => {
    renderTable();
    const chip = screen.getByRole('button', { name: a.showUnmatchedOnly });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events/e1?unmatchedOnly=1', { scroll: false });
  });

  it('turns "Show unmatched only" off by removing the parameter', () => {
    nav.search.current = new URLSearchParams('unmatchedOnly=1');
    renderTable({ unmatchedOnly: true });
    const chip = screen.getByRole('button', { name: a.showUnmatchedOnly });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events/e1', { scroll: false });
  });

  it('writes the payment status from a compact filter select, "All" removing it', () => {
    nav.search.current = new URLSearchParams('page=4');
    renderTable();
    // AURA's FilterSelect drives a native <select> under its face.
    const select = screen
      .getAllByRole('combobox', { name: a.paymentStatusFilter })
      .at(-1)!
      .closest('.aura-select')!
      .querySelector('select')!;
    fireEvent.change(select, { target: { value: 'refunded' } });
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events/e1?paymentStatus=refunded', { scroll: false });
    nav.search.current = new URLSearchParams('paymentStatus=refunded');
    const all = within(select).getByRole('option', { name: a.allPaymentStatuses, hidden: true }) as HTMLOptionElement;
    fireEvent.change(select, { target: { value: all.value } });
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events/e1', { scroll: false });
  });

  it('shows the count as the bar\'s polite live region', () => {
    renderTable({ rows: [row(), row({ registrationId: 'reg-2' as AttendeeRow['registrationId'] })] });
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('2 attendees');
  });
});

describe('attendee table (AURA DataTable)', () => {
  it('has the board\'s columns, the action column named', () => {
    renderTable();
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).toEqual([
      a.columns.attendee,
      a.columns.match,
      a.columns.ticket,
      a.columns.quota,
      a.columns.registered,
      a.columns.actions,
    ]);
  });

  it('hides the action column without relink rights (manager read-only)', () => {
    renderTable({ canRelink: false });
    expect(screen.queryByRole('columnheader', { name: a.columns.actions })).toBeNull();
  });

  it('draws the match and quota badges in the board\'s tones', () => {
    const m = en.admin.events.matchType;
    const q = en.admin.events.quotaEffect;
    renderTable({
      rows: [
        row({ registrationId: 'r1' as AttendeeRow['registrationId'], matchType: 'member_contact', countedAgainstCulturalQuota: true }),
        row({ registrationId: 'r2' as AttendeeRow['registrationId'], matchType: 'member_domain', countedAgainstCulturalQuota: false, countedAgainstPartnership: true }),
        row({ registrationId: 'r3' as AttendeeRow['registrationId'], matchType: 'member_fuzzy', countedAgainstCulturalQuota: false, isOverQuota: true }),
        row({ registrationId: 'r4' as AttendeeRow['registrationId'], matchType: 'unmatched', countedAgainstCulturalQuota: false }),
        row({ registrationId: 'r5' as AttendeeRow['registrationId'], matchType: 'non_member', countedAgainstCulturalQuota: false }),
      ],
    });
    const badge = (text: string) => screen.getAllByText(text)[0]!.closest('.aura-badge');
    expect(badge(m.member_contact)).toHaveClass('aura-badge--success');
    expect(badge(m.member_domain)).toHaveClass('aura-badge--success');
    expect(badge(m.member_fuzzy)).toHaveClass('aura-badge--warning');
    expect(badge(m.unmatched)).toHaveClass('aura-badge--danger');
    expect(badge(m.non_member)).toHaveClass('aura-badge--neutral');
    expect(badge(q.cultural)).toHaveClass('aura-badge--accent');
    expect(badge(q.partnership)).toHaveClass('aura-badge--accent');
    expect(badge(q.overQuota)).toHaveClass('aura-badge--danger');
    expect(badge(q.none)).toHaveClass('aura-badge--neutral');
  });

  it('shows the ticket with its payment status and keeps the copy-email button', () => {
    renderTable({ rows: [row({ ticketType: 'Partner ticket', ticketPriceThb: 1500, paymentStatus: 'refunded' })] });
    const r = screen.getAllByRole('row')[1]!;
    expect(within(r).getByText('Partner ticket')).toBeInTheDocument();
    expect(within(r).getByText(/Refunded/)).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: a.copyEmailAria.replace('{email}', 'erik@siamnordic.example') })).toBeInTheDocument();
  });

  it('keeps "Clear filters" in the filtered-empty state: one URL write, a toast, focus to the search', async () => {
    nav.search.current = new URLSearchParams('q=nobody&unmatchedOnly=1&paymentStatus=paid');
    renderTable({ rows: [], initialSearch: 'nobody', unmatchedOnly: true, initialPaymentStatus: 'paid' });
    expect(screen.getByText(a.emptyHeading)).toBeInTheDocument();
    const clear = screen.getAllByRole('button', { name: a.clearFilters }).at(-1)!;
    fireEvent.click(clear);
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events/e1', { scroll: false });
    expect(toastMock.success).toHaveBeenCalledWith(a.filtersCleared);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('searchbox', { name: a.searchLabel })).toHaveFocus();
  });
});
