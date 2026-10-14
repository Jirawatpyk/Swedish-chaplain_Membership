/**
 * Spec 122 US10a (T1002) — the users filters on AURA's FilterBar: search,
 * Role and Status as compact FilterSelects, every applied filter a removable
 * chip, and the count at the end of the row. The URL contract is today's:
 * each change replaces `?q/role/status`, drops `page`, keeps the scroll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const replace = vi.fn();
let searchParamsStub = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
  useSearchParams: () => searchParamsStub,
  usePathname: () => '/admin/users',
}));

import { UsersFilters } from '@/components/auth/users-filters';

const f = enMessages.admin.users.filters;

const tree = (resultCount?: number) => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <UsersFilters {...(resultCount !== undefined ? { resultCount } : {})} />
  </NextIntlClientProvider>
);

/** AURA's FilterSelect drives a native <select> under its face. */
const nativeSelect = (name: string) =>
  screen.getAllByRole('combobox', { name }).at(-1)!.closest('.aura-select')!.querySelector('select')!;

beforeEach(() => {
  replace.mockClear();
  searchParamsStub = new URLSearchParams();
});

describe('<UsersFilters> on AURA', () => {
  it('is one named filter region with the search box', () => {
    render(tree());
    expect(screen.getByRole('region', { name: f.groupLabel })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: f.searchSrLabel })).toBeInTheDocument();
  });

  it('a role pick replaces the URL, dropping the page, keeping the scroll', () => {
    searchParamsStub = new URLSearchParams('page=3&status=active');
    render(tree());
    fireEvent.change(nativeSelect(f.role.label), { target: { value: 'super_admin' } });
    expect(replace).toHaveBeenLastCalledWith('/admin/users?status=active&role=super_admin', { scroll: false });
  });

  it('offers every role that can exist, and "All roles" removes it', () => {
    searchParamsStub = new URLSearchParams('role=marketing');
    render(tree());
    const select = nativeSelect(f.role.label);
    const names = within(select)
      .getAllByRole('option', { hidden: true })
      .map((o) => o.textContent);
    expect(names).toEqual([f.role.all, f.role.super_admin, f.role.admin, f.role.manager, f.role.marketing, f.role.member]);
    fireEvent.change(select, { target: { value: 'all' } });
    expect(replace).toHaveBeenLastCalledWith('/admin/users', { scroll: false });
  });

  it('a status pick writes ?status', () => {
    render(tree());
    fireEvent.change(nativeSelect(f.status.label), { target: { value: 'disabled' } });
    expect(replace).toHaveBeenLastCalledWith('/admin/users?status=disabled', { scroll: false });
  });

  it('the search commits after the debounce', () => {
    searchParamsStub = new URLSearchParams('page=2');
    render(tree());
    fireEvent.change(screen.getByRole('searchbox', { name: f.searchSrLabel }), { target: { value: 'ann' } });
    expect(replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(350));
    expect(replace).toHaveBeenLastCalledWith('/admin/users?q=ann', { scroll: false });
  });

  it('shows each applied filter as a chip; removing one drops only that parameter', () => {
    searchParamsStub = new URLSearchParams('q=ann&role=admin&status=pending');
    render(tree());
    expect(screen.getByText('Search: ann')).toBeInTheDocument();
    expect(screen.getByText('Role: Admin')).toBeInTheDocument();
    expect(screen.getByText('Status: Pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Role: Admin' }));
    expect(replace).toHaveBeenLastCalledWith('/admin/users?q=ann&status=pending', { scroll: false });
  });

  it('Clear filters removes every filter', () => {
    searchParamsStub = new URLSearchParams('q=ann&role=admin&page=4');
    render(tree());
    fireEvent.click(screen.getByRole('button', { name: f.clear }));
    expect(replace).toHaveBeenLastCalledWith('/admin/users', { scroll: false });
  });

  it('shows no chips and no Clear when nothing is filtered', () => {
    render(tree());
    expect(screen.queryByRole('button', { name: f.clear })).not.toBeInTheDocument();
  });

  it('announces the count of every match across pages', () => {
    render(tree(148));
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('148 users');
  });

  // AURA 5.38 (handoff #140, #144): the bar's search and selects are 44px below
  // 640px or on touch, level with the 44px buttons beside them.
  it("gives the bar AURA's touch height", () => {
    render(tree());
    expect(screen.getByRole('region', { name: f.groupLabel }).closest('.aura-filterbar')).toHaveClass('is-touch');
  });
});
