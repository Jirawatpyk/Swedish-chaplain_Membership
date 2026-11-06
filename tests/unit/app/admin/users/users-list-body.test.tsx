// PR Q parity — an empty users list says it once: the AURA EmptyState, with
// no "No records" pager line under it (the invoices list already does this).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { UsersListBody } from '@/app/(staff)/admin/users/_components/users-list-body';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/admin/users',
}));

afterEach(cleanup);

const CAPS = { manageAccounts: true, manageStaffRoles: true } as const;

describe('UsersListBody — empty list', () => {
  it('shows no pager line when there are no users', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <UsersListBody
          users={[]}
          total={0}
          page={1}
          pageSize={25}
          currentUserId="u-self"
          capabilities={CAPS}
          now={new Date('2026-11-06T00:00:00Z')}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(en.pagination.emptyCount)).toBeNull();
    expect(document.querySelector('[data-slot="table-pagination"]')).toBeNull();
  });
});
