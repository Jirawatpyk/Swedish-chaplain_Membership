/**
 * `PipelineMoneyBand` unit test (formatting, basis caption, derived rate,
 * filter-shortcut hrefs).
 *
 * renewals-money-band-slim — the band was slimmed from 4 hero `KpiCard`
 * tiles down to a compact 2-KPI strip (Collection rate + Past due only;
 * Collected-this-month and Due-soon dropped from the RENDER, not the query —
 * `PipelineMoneySummary` still carries all 4 legs so tiles can be restored
 * without a query change). This file was rewritten test-first: the
 * assertions below were updated to describe the strip BEFORE
 * `pipeline-money-band.tsx` was edited to match (red → green).
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
  it('renders the grouped THB hero number for past due', () => {
    renderBand();
    expect(screen.getByText('500.00')).toBeInTheDocument(); // overdue / past due
  });

  it('groups large hero numbers with thousands separators (formatSatangThb, not formatSatangAsBaht)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineMoneyBand
          money={{
            settledDueToDateSatang: 0n,
            overdueSatang: 440000000n, // 4,400,000.00 THB
            collectedThisPeriodSatang: 0n,
            dueSoonSatang: 0n,
          }}
          windowDays={90}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('4,400,000.00')).toBeInTheDocument();
  });

  it('derives the collection rate (79.2%) from settled + overdue, not a stored field', () => {
    renderBand();
    // 190000 / (190000 + 50000) = 79.16 → "79.2%"
    expect(screen.getByText('79.2%')).toBeInTheDocument();
  });

  it('shows exactly ONE shared basis caption for the strip (not a per-tile caption each)', () => {
    renderBand();
    // The strip's single caption reads "membership · this fiscal year ·
    // incl. VAT" — assert there is exactly one "incl. VAT" occurrence (the
    // 4-tile predecessor had ≥4).
    expect(screen.getAllByText(/incl\. VAT/i)).toHaveLength(1);
    expect(screen.getByText(/this fiscal year/i)).toBeInTheDocument();
  });

  it('never labels a tile the bare word "Overdue" (F9 owns another overdue)', () => {
    renderBand();
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(screen.getByText('Past due')).toBeInTheDocument();
  });

  it('does not render the Collected-this-month or Due-soon KPIs (slimmed to 2 actionable KPIs)', () => {
    renderBand();
    expect(screen.queryByText('Collected this month')).toBeNull();
    expect(screen.queryByText('Due soon')).toBeNull();
    // Their money values must not leak into the strip either.
    expect(screen.queryByText('1,000.00')).toBeNull(); // collected leg
    expect(screen.queryByText('300.00')).toBeNull(); // due-soon leg
  });

  it('deep-links Past due to the existing URL contract; Collection rate stays display-only', () => {
    renderBand();
    expect(screen.getByRole('link', { name: /past due/i })).toHaveAttribute(
      'href',
      '/admin/renewals?month=overdue',
    );
    // The collection-rate KPI carries no link (display-only).
    expect(screen.queryByRole('link', { name: /collection rate/i })).toBeNull();
    // No leftover links for the dropped KPIs.
    expect(screen.queryByRole('link', { name: /collected this month/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /due soon/i })).toBeNull();
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

  it('gives the Past-due link a concise, purpose-stating aria-label distinct from the label+value sentence', () => {
    renderBand();
    expect(
      screen.getByRole('link', { name: /— view overdue renewals$/ }),
    ).toBeInTheDocument();
  });

  it('folds the THB figure into the Past-due aria-label so a screen-reader user hears the amount, not only the purpose', () => {
    renderBand();
    expect(
      screen.getByRole('link', {
        name: 'Past due 500.00 THB — view overdue renewals',
      }),
    ).toBeInTheDocument();
  });
});
