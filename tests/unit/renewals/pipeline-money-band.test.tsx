/**
 * DV-Wave2 ⑥ — `PipelineMoneyBand` unit test (formatting, basis captions,
 * derived rate, filter-shortcut hrefs).
 *
 * The band is a server presentational component; rendered here via
 * `NextIntlClientProvider` (the established next-intl unit-test pattern).
 * `vi.useRealTimers()` — the shared harness installs fake timers that would
 * hang React rendering (memory: component test harness fake timers).
 *
 * Fix round 1 #2 — hero numbers switched from `formatSatangAsBaht` (no
 * thousands grouping) to the canonical `formatSatangThb`. `1,000.00` below
 * (was `1000.00`) pins the grouped output; a dedicated large-value test pins
 * multi-comma grouping (e.g. millions) explicitly.
 *
 * Fix round 2 — tiles now render via the shared `KpiCard`; the existing
 * role/text queries below are unaffected (KpiCard renders the same visible
 * label/value/caption text, and `PipelineMoneyBand`'s new `ErrorBoundary`
 * wrapper adds no DOM of its own). New assertions cover the round-2
 * additions: concise per-tile `aria-label`s (#2) and the ICU-plural
 * `dueSoon.basis` (#5).
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
    expect(screen.getByText('1,000.00')).toBeInTheDocument(); // collected this month
    expect(screen.getByText('300.00')).toBeInTheDocument(); // due soon
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
    // Fix round 1 #4 — scoped to `&subject=membership` so the drill-down
    // matches the tile's membership-only scope.
    expect(screen.getByRole('link', { name: /collected this month/i })).toHaveAttribute(
      'href',
      '/admin/invoices?status=paid&subject=membership',
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

  it('#2 — gives each linked tile a concise, purpose-stating aria-label distinct from the full label+value+basis sentence', () => {
    renderBand();
    expect(
      screen.getByRole('link', { name: 'Past due — view overdue renewals' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Collected this month — view paid membership invoices',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Due soon — view renewals due in the next 30 days',
      }),
    ).toBeInTheDocument();
  });

  it('#5 — uses ICU plural for the dueSoon window ("1 day", not "1 days")', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineMoneyBand
          money={{
            settledDueToDateSatang: 0n,
            overdueSatang: 0n,
            collectedThisPeriodSatang: 0n,
            dueSoonSatang: 0n,
          }}
          windowDays={1}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/within 1 day\b/i)).toBeInTheDocument();
    expect(screen.queryByText(/within 1 days/i)).toBeNull();
  });
});
