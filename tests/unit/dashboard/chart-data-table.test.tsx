/**
 * Task 8 (067-dashboard-interactive-charts) — shared `<ChartDataTable>`.
 *
 * This component IS the accessibility path for every Recharts chart: the
 * canvas is `aria-hidden`, and this server-rendered `<table>` carries the
 * real data for screen-reader + no-JS users (WCAG 1.1.1 / 1.3.1 / 1.4.1). A
 * plain jsdom render must produce the table with no client-mount gate —
 * it is pure markup from props, never `'use client'`.
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ChartDataTable } from '@/components/dashboard/chart-data-table';

describe('ChartDataTable', () => {
  it('renders a table with the caption, one <th> per column, and one row per datum', () => {
    render(
      <ChartDataTable
        caption="Revenue trend"
        columns={['Month', 'Amount']}
        rows={[
          ['Jan 2026', 'THB 1,000'],
          ['Feb 2026', 'THB 2,000'],
        ]}
      />,
    );

    const table = screen.getByRole('table');
    expect(within(table).getByText('Revenue trend')).toBeInTheDocument();

    expect(within(table).getByRole('columnheader', { name: 'Month' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Amount' })).toBeInTheDocument();

    // header row + 2 data rows
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('rowheader', { name: 'Jan 2026' })).toBeInTheDocument();
    expect(within(table).getByText('THB 1,000')).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Feb 2026' })).toBeInTheDocument();
    expect(within(table).getByText('THB 2,000')).toBeInTheDocument();
  });

  it('is visually hidden but present in the accessibility tree (sr-only, never aria-hidden)', () => {
    render(<ChartDataTable caption="Cap" columns={['A']} rows={[['x']]} />);
    const table = screen.getByRole('table');
    expect(table).toHaveClass('sr-only');
    expect(table).not.toHaveAttribute('aria-hidden');
  });

  it('renders numeric cells (caller passes pre-formatted strings/numbers)', () => {
    render(<ChartDataTable caption="Tiers" columns={['Tier', 'Count']} rows={[['Gold', 12]]} />);
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('supports rows with more than 2 cells (e.g. a totals row: label, count, %)', () => {
    render(
      <ChartDataTable
        caption="Membership by tier"
        columns={['Tier', 'Count', '%']}
        rows={[
          ['Gold', 12, '60%'],
          ['Silver', 8, '40%'],
          ['Total', 20, '100%'],
        ]}
      />,
    );
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3 rows
    expect(within(table).getByRole('rowheader', { name: 'Total' })).toBeInTheDocument();
    expect(within(table).getByText('100%')).toBeInTheDocument();
  });
});
