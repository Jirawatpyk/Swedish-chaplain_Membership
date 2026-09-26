/**
 * Spec 122 US1 T108 — TablePagination on AURA Pagination keeps its contract:
 * the "Showing X–Y of Z" summary, real page links that carry the current
 * filters (page 1 drops `page=`), the current page marked, no navigation
 * when everything fits on one page, and the `table-pagination` data-slot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { TablePagination } from '@/components/layout/table-pagination';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams('q=siam&page=2'),
}));

function renderPagination(props: { page: number; total: number }) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TablePagination pageSize={10} {...props} />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('TablePagination (spec 122 US1)', () => {
  it('summarises the rows and links every page with the current filters kept', () => {
    const { container } = renderPagination({ page: 2, total: 131 });
    expect(container.querySelector('[data-slot="table-pagination"]')).not.toBeNull();
    expect(screen.getByText('Showing 11–20 of 131')).toBeInTheDocument();

    const nav = screen.getByRole('navigation');
    const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    // Page 1 drops `page=`; the search survives on every link.
    expect(hrefs).toContain('/admin/members?q=siam');
    expect(hrefs).toContain('/admin/members?q=siam&page=3');
    expect(hrefs).toContain('/admin/members?q=siam&page=14');
    expect(nav.querySelector('[aria-current="page"]')).toHaveTextContent('2');
  });

  it('renders no page navigation when everything fits on one page', () => {
    renderPagination({ page: 1, total: 7 });
    expect(screen.getByText('Showing 1–7 of 7')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
});
