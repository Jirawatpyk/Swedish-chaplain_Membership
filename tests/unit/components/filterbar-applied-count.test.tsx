/**
 * Spec 122 (2026-10-15, AURA #146) — on phones each list's "Filters (n)"
 * button counts every applied filter, not only the ones shown as chips.
 *
 * AURA counts the bar's chips by default. These bars also have a toggle
 * (Tag or Checkbox) that is not repeated as a chip, so they pass
 * `filterCount`: with only the toggle on, the button reads "Filters (1)"
 * ("Filters, 1 applied" to a screen reader) rather than a bare "Filters".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
