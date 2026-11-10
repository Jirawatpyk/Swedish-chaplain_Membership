/**
 * #765 — applying or clearing the invoices card's filters starts its pager
 * again at page 1 (`invPage` dropped), so a filter never lands on a page past
 * the end of a shorter result. The member page's other params survive.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members/m-1',
  useSearchParams: () => new URLSearchParams('tab=overview&invQ=acme&invPage=3'),
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
}));

const { MemberInvoicesFilters } = await import(
  '@/app/(staff)/admin/members/[memberId]/_components/member-invoices-filters'
);
const F = enMessages.admin.members.invoices.filters;

function renderFilters() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MemberInvoicesFilters />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  replace.mockClear();
});

describe('member invoices filters reset the pager (#765)', () => {
  it('Apply drops invPage and keeps the other params', () => {
    renderFilters();
    fireEvent.change(screen.getByLabelText(F.searchLabel), { target: { value: 'nordic' } });
    fireEvent.click(screen.getByRole('button', { name: F.apply }));
    expect(replace).toHaveBeenCalledWith('/admin/members/m-1?tab=overview&invQ=nordic', { scroll: false });
  });

  it('Clear drops invPage too', () => {
    renderFilters();
    fireEvent.click(screen.getByRole('button', { name: F.clear }));
    expect(replace).toHaveBeenCalledWith('/admin/members/m-1?tab=overview', { scroll: false });
  });
});
