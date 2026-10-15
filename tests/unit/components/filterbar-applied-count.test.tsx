/**
 * Spec 122 (2026-10-15, AURA #146) — on phones each list's "Filters (n)"
 * button counts every applied filter, not only the ones shown as chips.
 *
 * AURA counts the bar's chips by default. These bars also have a toggle
 * (Tag or Checkbox) that is not repeated as a chip, so they pass
 * `filterCount`: with only the toggle on, the button reads "Filters (1)"
 * ("Filters, 1 applied" to a screen reader) rather than a bare "Filters".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { asEventId } from '@/modules/events';

const nav = vi.hoisted(() => ({ search: { current: new URLSearchParams() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/list',
  useSearchParams: () => nav.search.current,
}));

const { AttendeeTable } = await import('@/components/events/attendee-table');
const { DirectoryFilters } = await import('@/components/members/directory-filters');
const { PlansTable } = await import('@/components/plans/plans-table');
const { InvoiceFilters } = await import('@/app/(staff)/admin/invoices/_components/invoice-filters');
const { DirectorySearchFilters } = await import('@/components/directory/directory-search-filters');
const { UsersFilters } = await import('@/components/auth/users-filters');
const { CreditNoteFilters } = await import('@/app/(staff)/admin/credit-notes/_components/credit-note-filters');
const { AuditFilters } = await import('@/components/audit/audit-filters');
const { EventsListFilters } = await import('@/components/events/events-list-filters');

const wrap = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Asia/Bangkok">
      {ui}
    </NextIntlClientProvider>,
  );

const filtersButton = () => screen.getByRole('button', { name: /^Filters/ });

beforeEach(() => {
  nav.search.current = new URLSearchParams();
});

describe('the phone "Filters (n)" button counts toggles that have no chip', () => {
  it('attendees: "Show unmatched only"', () => {
    nav.search.current = new URLSearchParams('unmatchedOnly=1');
    wrap(
      <AttendeeTable
        rows={[]}
        unmatchedOnly
        initialSearch=""
        eventId={asEventId('00000000-0000-4000-8000-000000000001')}
        canRelink={false}
        canErase={false}
        totalCount={0}
      />,
    );
    expect(filtersButton()).toHaveAccessibleName('Filters, 1 applied');
  });

  it('members: "Needs portal invite"', () => {
    nav.search.current = new URLSearchParams('portal=needs_invite');
    wrap(<DirectoryFilters portalInviteCount={3} />);
    expect(filtersButton()).toHaveAccessibleName('Filters, 1 applied');
  });

  it('plans: "Active only"', () => {
    wrap(
      <PlansTable
        plans={[]}
        currencyCode="THB"
        year={2026}
        currentUserRole="admin"
        initialFilter={{ category: null, q: null, activeOnly: true, showDeleted: false }}
      />,
    );
    expect(filtersButton()).toHaveAccessibleName('Filters, 1 applied');
  });

  it('invoices (no tax filters): "Paid online"', () => {
    nav.search.current = new URLSearchParams('paidOnline=1');
    wrap(<InvoiceFilters />);
    expect(filtersButton()).toHaveAccessibleName('Filters, 1 applied');
  });

  it('member directory: "Listed only"', () => {
    nav.search.current = new URLSearchParams('listed=true');
    wrap(<DirectorySearchFilters />);
    expect(filtersButton()).toHaveAccessibleName('Filters, 1 applied');
  });
});

// UX review (2026-10-15): the search stays in the bar, so a search term is
// not one of the filters the button counts ("Filters (n)" names what is in
// the sheet), even where the bar shows it as a chip.
describe('the phone "Filters (n)" button does not count the search', () => {
  const attendee = () => (
    <AttendeeTable
      rows={[]}
      unmatchedOnly={false}
      initialSearch="acme"
      eventId={asEventId('00000000-0000-4000-8000-000000000001')}
      canRelink={false}
      canErase={false}
      totalCount={0}
    />
  );
  const plans = () => (
    <PlansTable
      plans={[]}
      currencyCode="THB"
      year={2026}
      currentUserRole="admin"
      initialFilter={{ category: null, q: 'acme', activeOnly: false, showDeleted: false }}
    />
  );
  it.each([
    ['invoices', 'q=acme', () => <InvoiceFilters />],
    ['members', 'q=acme', () => <DirectoryFilters />],
    ['attendees', 'q=acme', attendee],
    ['users', 'q=acme', () => <UsersFilters />],
    ['plans', '', plans],
    ['credit notes', 'q=acme', () => <CreditNoteFilters />],
    ['audit', 'targetRef=acme', () => <AuditFilters eventTypeOptions={[]} timeZone="Asia/Bangkok" />],
  ] as const)('%s: a search alone reads "Filters"', (_name, query, ui) => {
    nav.search.current = new URLSearchParams(query);
    wrap(ui());
    expect(filtersButton()).toHaveAccessibleName('Filters');
  });
});

// UX review (2026-10-15): a list's own Clear pressed inside the sheet
// unmounts itself; focus moves to the sheet's Done, not to the search behind
// the modal.
describe('a Clear pressed inside the Filters sheet', () => {
  const width = window.innerWidth;
  afterEach(() => {
    window.innerWidth = width;
  });
  it('moves focus to Done', async () => {
    window.innerWidth = 390;
    nav.search.current = new URLSearchParams('partnerBenefitOnly=1');
    wrap(
      <EventsListFilters search="" partnerBenefitOnly culturalEventOnly={false} includeArchived={false} resultCount={1} />,
    );
    fireEvent.click(filtersButton());
    const sheet = screen.getByRole('dialog', { name: 'Filters' });
    const clear = within(sheet).getByRole('button', { name: en.admin.events.list.filters.clearAll });
    clear.focus();
    fireEvent.click(clear);
    await Promise.resolve();
    expect(within(sheet).getByRole('button', { name: 'Done' })).toHaveFocus();
  });
});

