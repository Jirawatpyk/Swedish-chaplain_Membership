import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MonthBarChart } from '@/components/renewals/month-bar-chart';
import type { MonthBarItem } from '@/components/renewals/month-bucket-label';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams(''),
}));

function renderChart(items: MonthBarItem[], selectedKey: string | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MonthBarChart items={items} selectedKey={selectedKey} />
    </NextIntlClientProvider>,
  );
}

const ITEMS: MonthBarItem[] = [
  { key: 'overdue', label: 'Overdue', count: 2, barPercent: 12, interactive: true },
  { key: '2026-07', label: 'July 2026', count: 17, barPercent: 100, interactive: true },
  { key: '2026-08', label: 'August 2026', count: 0, barPercent: 0, interactive: false },
  { key: 'later', label: 'July 2027 or later', count: 1, barPercent: 4, interactive: true },
];

describe('MonthBarChart', () => {
  it('renders a list with one row per bucket + counts', () => {
    renderChart(ITEMS);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('17')).toBeInTheDocument();
  });

  it('nonzero buckets are links to ?month=<key>', () => {
    renderChart(ITEMS);
    const link = screen.getByRole('link', { name: /July 2026/ });
    expect(link).toHaveAttribute('href', expect.stringContaining('month=2026-07'));
  });

  it('a zero bucket is NOT a link and is aria-disabled', () => {
    renderChart(ITEMS);
    expect(screen.queryByRole('link', { name: /August 2026/ })).toBeNull();
    expect(screen.getByText('August 2026').closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it('the selected bucket carries aria-current', () => {
    renderChart(ITEMS, '2026-07');
    const link = screen.getByRole('link', { name: /July 2026/ });
    expect(link).toHaveAttribute('aria-current', 'true');
  });
});
