import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MonthBarChart } from '@/components/renewals/month-bar-chart';
import type { MonthBarItem } from '@/components/renewals/month-bucket-label';
import en from '@/i18n/messages/en.json';

// Seed the current URL with a stale urgency lens + tier filter + cursor so
// the "nonzero → link" test can prove the href builder sets `month` AND
// deletes `urgency` (mutually-exclusive lens), `tier` (whole-tenant lens
// can't honour a tier filter), and `cursor` (pagination reset).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/renewals',
  useSearchParams: () => new URLSearchParams('urgency=t-30&cursor=abc123&tier=premium'),
}));

function renderChart(items: MonthBarItem[], selectedKey: string | null = null) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MonthBarChart items={items} selectedKey={selectedKey} />
    </NextIntlClientProvider>,
  );
}

const ITEMS: MonthBarItem[] = [
  { key: 'overdue', label: 'Overdue', shortLabel: 'Overdue', count: 2, barPercent: 12, interactive: true, band: 't-0' },
  { key: '2026-07', label: 'July 2026', shortLabel: 'Jul 26', count: 17, barPercent: 100, interactive: true, band: 't-7' },
  { key: '2026-08', label: 'August 2026', shortLabel: 'Aug 26', count: 0, barPercent: 0, interactive: false, band: 't-14' },
  { key: 'later', label: 'July 2027 or later', shortLabel: 'Jul 27+', count: 1, barPercent: 4, interactive: true, band: 't-90' },
];

describe('MonthBarChart', () => {
  it('renders a list with one row per bucket + counts', () => {
    renderChart(ITEMS);
    expect(screen.getByRole('list')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('17')).toBeInTheDocument();
  });

  it('nonzero buckets link to ?month=<key> and clear the urgency+tier+cursor params', () => {
    renderChart(ITEMS);
    const link = screen.getByRole('link', { name: /July 2026/ });
    const href = link.getAttribute('href') ?? '';
    expect(href).toContain('month=2026-07');
    expect(href).not.toContain('urgency=');
    expect(href).not.toContain('tier=');
    expect(href).not.toContain('cursor=');
  });

  it('a zero bucket is a non-interactive image (not a link), labelled "no members"', () => {
    renderChart(ITEMS);
    // Not a link — nothing to filter to.
    expect(screen.queryByRole('link', { name: /August 2026/ })).toBeNull();
    // Rendered as role="img" with the full label as its accessible name; the
    // visible content is the compact short label.
    const zero = screen.getByRole('img', { name: /August 2026/ });
    expect(zero).toBeInTheDocument();
    expect(zero).toHaveTextContent('Aug 26');
  });

  it('the selected bucket carries aria-current', () => {
    renderChart(ITEMS, '2026-07');
    const link = screen.getByRole('link', { name: /July 2026/ });
    expect(link).toHaveAttribute('aria-current', 'true');
  });
});
