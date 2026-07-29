/**
 * `PipelineMoneyBand` unit test (formatting, basis captions, derived rate,
 * filter-shortcut hrefs, tone tokens).
 *
 * renewals-money-band-compact4 — the band went 4 hero `KpiCard` tiles →
 * `renewals-money-band-slim`'s 2-KPI strip → back to all 4 KPIs, this time
 * as a shorter COMPACT tile (Card `size="sm"` + `text-2xl` value) instead of
 * the original `text-3xl` hero. This file was rewritten test-first: the
 * assertions below were updated to describe the compact 4-tile band BEFORE
 * `pipeline-money-band.tsx` was edited to match (red → green).
 *
 * The band is a server presentational component; rendered here via
 * `NextIntlClientProvider` (the established next-intl unit-test pattern).
 * `vi.useRealTimers()` — the shared harness installs fake timers that would
 * hang React rendering (memory: component test harness fake timers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
          // renewals-overdue-prior-fy-subline — the real prod case that
          // motivated the sub-line: 1 bill, ฿38,520, due Aug 2025.
          overdueBeforeFySatang: 3852000n,
          overdueBeforeFyCount: 1,
        }}
        windowDays={90}
      />
    </NextIntlClientProvider>,
  );
}

describe('PipelineMoneyBand', () => {
  it('renders THB hero numbers for all 4 tiles', () => {
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
            overdueBeforeFySatang: 0n,
            overdueBeforeFyCount: 0,
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

  it('shows all 4 labels with their OWN basis caption each (not one shared strip caption)', () => {
    renderBand();
    expect(screen.getByText('Collection rate')).toBeInTheDocument();
    expect(screen.getByText('Past due')).toBeInTheDocument();
    expect(screen.getByText('Collected this month')).toBeInTheDocument();
    expect(screen.getByText('Due soon')).toBeInTheDocument();
    // 4 distinct per-tile "incl. VAT" basis captions, not a single shared one.
    expect(screen.getAllByText(/incl\. VAT/i)).toHaveLength(4);
    expect(screen.getByText(/within 90 days/i)).toBeInTheDocument();
  });

  it('never labels a tile the bare word "Overdue" (F9 owns another overdue)', () => {
    renderBand();
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(screen.getByText('Past due')).toBeInTheDocument();
  });

  it('deep-links Past due and Collected this month; Collection rate + Due soon stay display-only', () => {
    renderBand();
    expect(screen.getByRole('link', { name: /past due/i })).toHaveAttribute(
      'href',
      '/admin/renewals?month=overdue',
    );
    expect(screen.getByRole('link', { name: /collected this month/i })).toHaveAttribute(
      'href',
      '/admin/invoices?status=paid&subject=membership',
    );
    // Display-only tiles carry no link.
    expect(screen.queryByRole('link', { name: /collection rate/i })).toBeNull();
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
            overdueBeforeFySatang: 0n,
            overdueBeforeFyCount: 0,
          }}
          windowDays={90}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('gives each linked tile a concise, purpose-stating aria-label distinct from the full label+value+basis sentence', () => {
    renderBand();
    expect(screen.getByRole('link', { name: /— view overdue renewals$/ })).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /— view paid membership invoices$/ }),
    ).toBeInTheDocument();
  });

  it('folds the THB figure into each linked tile aria-label so a screen-reader user hears the amount, not only the purpose', () => {
    renderBand();
    expect(
      screen.getByRole('link', { name: 'Past due 500.00 THB — view overdue renewals' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: 'Collected this month 1,000.00 THB — view paid membership invoices',
      }),
    ).toBeInTheDocument();
  });

  it('uses ICU plural for the dueSoon window ("1 day", not "1 days")', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineMoneyBand
          money={{
            settledDueToDateSatang: 0n,
            overdueSatang: 0n,
            collectedThisPeriodSatang: 0n,
            dueSoonSatang: 0n,
            overdueBeforeFySatang: 0n,
            overdueBeforeFyCount: 0,
          }}
          windowDays={1}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/within 1 day\b/i)).toBeInTheDocument();
    expect(screen.queryByText(/within 1 days/i)).toBeNull();
  });

  it('colours Collection rate success (an attention-free "how are we doing" signal) and Past due warning (needs attention)', () => {
    renderBand();
    expect(screen.getByText('79.2%')).toHaveClass('text-success');
    // The past-due value is inside the deep-link; find the hero figure text node.
    const pastDueLink = screen.getByRole('link', { name: /past due/i });
    expect(pastDueLink.querySelector('.text-warning')).not.toBeNull();
  });

  it('does NOT tone-colour the neutral tiles (Collected this month, Due soon)', () => {
    renderBand();
    const collectedLink = screen.getByRole('link', { name: /collected this month/i });
    expect(collectedLink.querySelector('.text-success')).toBeNull();
    expect(collectedLink.querySelector('.text-warning')).toBeNull();
  });

  it('renders each compact tile value at text-2xl, not the text-3xl hero size', () => {
    renderBand();
    expect(screen.getByText('79.2%')).toHaveClass('text-2xl');
    expect(screen.getByText('79.2%')).not.toHaveClass('text-3xl');
  });

  // ---- renewals-overdue-prior-fy-subline ----

  it('shows the prior-years sub-line under Past due when overdueBeforeFySatang > 0, with ICU plural ("1 bill", not "1 bills")', () => {
    renderBand();
    expect(
      screen.getByText('+ 38,520.00 THB overdue from prior years (1 bill)'),
    ).toBeInTheDocument();
  });

  it('renders the sub-line as a drill-down link to the overdue membership invoices list (UX follow-up F3)', () => {
    renderBand();
    // `status=overdue` is the DERIVED filter (issued + past-due) — the most
    // precise filter the invoices list exposes via URL; no due-date-range
    // param exists to isolate the prior-FY rows further.
    expect(
      screen.getByRole('link', {
        name: '+ 38,520.00 THB overdue from prior years (1 bill)',
      }),
    ).toHaveAttribute('href', '/admin/invoices?status=overdue&subject=membership');
  });

  it('hides the prior-years sub-line entirely when overdueBeforeFySatang is 0 (tile byte-identical to before)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineMoneyBand
          money={{
            settledDueToDateSatang: 190000n,
            overdueSatang: 50000n,
            collectedThisPeriodSatang: 100000n,
            dueSoonSatang: 30000n,
            overdueBeforeFySatang: 0n,
            overdueBeforeFyCount: 0,
          }}
          windowDays={90}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/overdue from prior years/i)).toBeNull();
  });

  it('keeps the prior-years sub-line OUTSIDE the Past-due deep-link (its aria-label would swallow nested text for screen readers)', () => {
    renderBand();
    const subline = screen.getByText('+ 38,520.00 THB overdue from prior years (1 bill)');
    const pastDueLink = screen.getByRole('link', { name: /past due/i });
    expect(pastDueLink).not.toContainElement(subline);
  });

  it('does not change the Past-due tile main figure or aria-label when the sub-line is present', () => {
    renderBand();
    expect(screen.getByText('500.00')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Past due 500.00 THB — view overdue renewals' }),
    ).toBeInTheDocument();
  });

  it('renders a keyboard-focusable info-hint trigger on the Collection-rate tile explaining the basis divergence from the dashboard', () => {
    renderBand();
    const trigger = screen.getByRole('button', {
      name: "How this differs from the dashboard's Paid revenue",
    });
    expect(trigger).toBeInTheDocument();
    // Native <button> trigger (Base UI default) — actually focusable, unlike
    // the span-rendered trigger of the T160 regression.
    trigger.focus();
    expect(trigger).toHaveFocus();
  });

  it('opens the basis popover on click and closes it on ESC (touch + keyboard reachable, not hover-only)', async () => {
    const user = userEvent.setup();
    renderBand();
    const trigger = screen.getByRole('button', {
      name: "How this differs from the dashboard's Paid revenue",
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(
      await screen.findByText(/Counts membership bills DUE in the current fiscal year/),
    ).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByText(/Counts membership bills DUE in the current fiscal year/),
      ).toBeNull(),
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the basis popover with the keyboard (Enter on the focused trigger)', async () => {
    const user = userEvent.setup();
    renderBand();
    const trigger = screen.getByRole('button', {
      name: "How this differs from the dashboard's Paid revenue",
    });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(
      await screen.findByText(/Counts membership bills DUE in the current fiscal year/),
    ).toBeInTheDocument();
  });

  it('does NOT nest the info-hint trigger inside any deep-link (no nested interactive control)', () => {
    renderBand();
    const trigger = screen.getByRole('button', {
      name: "How this differs from the dashboard's Paid revenue",
    });
    expect(trigger.closest('a')).toBeNull();
  });
});
