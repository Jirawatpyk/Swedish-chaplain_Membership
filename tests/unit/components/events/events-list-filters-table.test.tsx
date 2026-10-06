/**
 * Spec 122 US9a (T902) — the events list's filter row and table on AURA
 * (board `Admin-events`, docs/aura-adoption.md § Filters):
 *
 * - AURA FilterBar: the search, then three toggle chips; each writes today's
 *   URL parameter (`q`, `partnerBenefitOnly`, `culturalEventOnly`,
 *   `includeArchived`) and drops `page`, in place (`router.replace`).
 * - The result count is the bar's live region and names the search.
 * - The table: Date, Name (+ Archived), Category, Registrations, Partner
 *   benefit, Match rate with its band word shown ("83.3% · Strong").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { EventId } from '@/modules/events';

const nav = vi.hoisted(() => ({ replace: vi.fn(), search: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: nav.replace }),
  usePathname: () => '/admin/events',
  useSearchParams: () => nav.search.current,
}));

const { EventsListFilters } = await import('@/components/events/events-list-filters');
const { EventsListTable } = await import('@/components/events/events-list-table');

const l = en.admin.events.list;

function renderFilters(props: Partial<Parameters<typeof EventsListFilters>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EventsListFilters
        search=""
        partnerBenefitOnly={false}
        culturalEventOnly={false}
        includeArchived={false}
        resultCount={4}
        {...props}
      />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  nav.replace.mockReset();
  nav.search.current = new URLSearchParams();
});

describe('events list filters (AURA FilterBar)', () => {
  it('writes each toggle chip to its URL parameter, keeping the others and dropping the page', () => {
    nav.search.current = new URLSearchParams('q=mid&page=3');
    renderFilters({ search: 'mid' });
    fireEvent.click(screen.getByRole('button', { name: l.filters.partnerBenefitOnly }));
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events?q=mid&partnerBenefitOnly=1', { scroll: false });
    fireEvent.click(screen.getByRole('button', { name: l.filters.culturalEventOnly }));
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events?q=mid&culturalEventOnly=1', { scroll: false });
    fireEvent.click(screen.getByRole('button', { name: l.filters.showArchived }));
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events?q=mid&includeArchived=1', { scroll: false });
  });

  it('turns an active chip off by removing its parameter', () => {
    nav.search.current = new URLSearchParams('partnerBenefitOnly=1');
    renderFilters({ partnerBenefitOnly: true });
    const chip = screen.getByRole('button', { name: l.filters.partnerBenefitOnly });
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events', { scroll: false });
  });

  it('writes the search to `q` on Enter and strips it when cleared', () => {
    renderFilters();
    const box = screen.getByRole('searchbox', { name: l.searchLabel });
    fireEvent.change(box, { target: { value: 'midsummer' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events?q=midsummer', { scroll: false });
    nav.search.current = new URLSearchParams('q=midsummer');
    fireEvent.change(box, { target: { value: '' } });
    act(() => vi.runOnlyPendingTimers());
    expect(nav.replace).toHaveBeenLastCalledWith('/admin/events', { scroll: false });
  });

  it('announces the count with the search in the bar\'s own live region', () => {
    const { container } = renderFilters({ search: 'midsummer', resultCount: 5 });
    const live = container.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent('5 events for \'midsummer\'');
  });
});

const ROW = {
  eventId: 'e-1' as EventId,
  name: 'Midsummer Mixer',
  startDate: '2026-06-19T10:00:00.000Z',
  category: 'Networking',
  totalRegistrations: 42,
  matchedRegistrations: 35,
  matchRatePct: 83.33,
  isPartnerBenefit: true,
  isCulturalEvent: false,
  archivedAt: null as string | null,
};

function renderTable(rows = [ROW]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <EventsListTable rows={rows} />
    </NextIntlClientProvider>,
  );
}

describe('events list table (AURA)', () => {
  it('has the board\'s columns', () => {
    renderTable();
    for (const name of [l.columns.date, l.columns.name, l.columns.category, l.columns.registrations, l.columns.partnerBenefit, l.columns.matchRate]) {
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    }
  });

  it('links the name, and shows the match rate with its band word', () => {
    renderTable();
    expect(screen.getByRole('link', { name: 'Midsummer Mixer' })).toHaveAttribute('href', '/admin/events/e-1');
    expect(screen.getByText(/83\.3%/).textContent).toContain(l.matchRateBandShort.high);
    expect(screen.getByText(l.matchRateOf.replace('{matched}', '35').replace('{total}', '42'))).toBeInTheDocument();
  });

  it('marks an archived event with a badge, and a benefit with its badge', () => {
    renderTable([{ ...ROW, archivedAt: '2026-07-01T00:00:00.000Z' }]);
    const row = screen.getByRole('link', { name: 'Midsummer Mixer' }).closest('[role="row"]') as HTMLElement;
    expect(within(row).getByText(l.badges.archived).closest('.aura-badge')).not.toBeNull();
    expect(within(row).getByText(l.badges.partnerBenefit).closest('.aura-badge')).not.toBeNull();
  });

  it('shows a dash, not a band word, when an event has no registrations', () => {
    renderTable([{ ...ROW, totalRegistrations: 0, matchedRegistrations: 0, matchRatePct: 0 }]);
    expect(screen.queryByText(new RegExp(l.matchRateBandShort.high))).toBeNull();
  });
});
