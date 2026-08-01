import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ErasureFilterTabs } from '@/app/(staff)/admin/compliance/erasure-log/_components/erasure-filter-tabs';
import type { ErasureStatusFilter } from '@/modules/insights';

const summary = { overdue: 1, inProgress: 2, complete: 14, total: 17 };
function renderTabs(active: ErasureStatusFilter = 'all', q = '') {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ErasureFilterTabs active={active} summary={summary} q={q} />
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('ErasureFilterTabs', () => {
  it('renders four status links inside a nav landmark with counts', () => {
    renderTabs();
    const nav = screen.getByRole('navigation', { name: /filter erasures by status/i });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(4);
    expect(within(nav).getByText('17')).toBeInTheDocument(); // All
    expect(within(nav).getByText('1')).toBeInTheDocument();  // Overdue
  });

  it('marks the active status with aria-current=page', () => {
    renderTabs('overdue');
    expect(screen.getByRole('link', { name: /overdue/i })).toHaveAttribute('aria-current', 'page');
  });

  it('preserves the q param in every href and omits status for All', () => {
    renderTabs('all', '42');
    const all = screen.getByRole('link', { name: /all/i });
    const overdue = screen.getByRole('link', { name: /overdue/i });
    expect(all).toHaveAttribute('href', '/admin/compliance/erasure-log?q=42');
    expect(overdue).toHaveAttribute('href', '/admin/compliance/erasure-log?status=overdue&q=42');
  });

  it('shows the ⚠ overdue affordance only when overdue > 0', () => {
    const { rerender } = renderTabs();
    expect(screen.getByTestId('overdue-warning')).toBeInTheDocument();
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ErasureFilterTabs active="all" summary={{ overdue: 0, inProgress: 0, complete: 3, total: 3 }} q="" />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('overdue-warning')).not.toBeInTheDocument();
  });
});
