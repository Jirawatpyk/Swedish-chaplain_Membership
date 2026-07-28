/**
 * DV-Wave2 ⑥ — `PipelineMoneyBand` unit test (formatting, basis captions,
 * derived rate, filter-shortcut hrefs).
 *
 * The band is a server presentational component; rendered here via
 * `NextIntlClientProvider` (the established next-intl unit-test pattern).
 * `vi.useRealTimers()` — the shared harness installs fake timers that would
 * hang React rendering (memory: component test harness fake timers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { PipelineMoneyBand } from '@/app/(staff)/admin/renewals/_components/pipeline-money-band';

beforeEach(() => vi.useRealTimers());

function renderBand() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PipelineMoneyBand
        money={{
          settledDueToDateSatang: 190000n,
          overdueSatang: 50000n,
          collectedThisPeriodSatang: 100000n,
          dueSoonSatang: 30000n,
        }}
        windowDays={90}
      />
    </NextIntlClientProvider>,
  );
}

describe('PipelineMoneyBand', () => {
  it('renders THB hero numbers for each money tile', () => {
    renderBand();
    expect(screen.getByText('500.00')).toBeInTheDocument(); // overdue / past due
    expect(screen.getByText('1000.00')).toBeInTheDocument(); // collected this month
    expect(screen.getByText('300.00')).toBeInTheDocument(); // due soon
  });

  it('derives the collection rate (79.2%) from settled + overdue, not a stored field', () => {
    renderBand();
    // 190000 / (190000 + 50000) = 79.16 → "79.2%"
    expect(screen.getByText('79.2%')).toBeInTheDocument();
  });

  it('shows a basis caption on every tile (never a bare label)', () => {
    renderBand();
    // At least one "incl. VAT" basis caption is present.
    expect(screen.getAllByText(/incl\. VAT/i).length).toBeGreaterThanOrEqual(4);
    // The dueSoon caption interpolates the window days.
    expect(screen.getByText(/within 90 days/i)).toBeInTheDocument();
  });

  it('never labels a tile the bare word "Overdue" (F9 owns another overdue)', () => {
    renderBand();
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(screen.getByText('Past due')).toBeInTheDocument();
  });

  it('deep-links each money tile to the existing URL contract; rate is display-only', () => {
    renderBand();
    expect(screen.getByRole('link', { name: /past due/i })).toHaveAttribute(
      'href',
      '/admin/renewals?month=overdue',
    );
    expect(screen.getByRole('link', { name: /collected this month/i })).toHaveAttribute(
      'href',
      '/admin/invoices?status=paid',
    );
    expect(screen.getByRole('link', { name: /due soon/i })).toHaveAttribute(
      'href',
      '/admin/renewals?urgency=t-30',
    );
    // The collection-rate tile carries no link (display-only).
    expect(screen.queryByRole('link', { name: /collection rate/i })).toBeNull();
  });

  it('renders "—" for the rate when nothing has come due this fiscal year', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineMoneyBand
          money={{
            settledDueToDateSatang: 0n,
            overdueSatang: 0n,
            collectedThisPeriodSatang: 0n,
            dueSoonSatang: 0n,
          }}
          windowDays={90}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
