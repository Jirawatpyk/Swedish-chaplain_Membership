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
 * 122 US7a (T704): four AURA `Stat` tiles (board `Admin-renewals`). Each
 * value reads as one "500.00 THB" string in the page's text colour (the board
 * draws no tone on the figures); a linked tile's label carries the link and
 * its arrow icon, so the prior-years line (danger tone) stays a separate
 * link inside the tile. The basis hint is an AURA popover.
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
import {
  PipelineMoneyBand,
  PipelineMoneyBandSkeleton,
} from '@/app/(staff)/admin/renewals/_components/pipeline-money-band';

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
          fyStartDate: '2026-01-01',
        }}
        windowDays={90}
      />
    </NextIntlClientProvider>,
  );
}

describe('PipelineMoneyBand', () => {
  it('renders THB hero numbers for all 4 tiles', () => {
    renderBand();
    expect(screen.getByText('500.00 THB')).toBeInTheDocument(); // overdue / past due
    expect(screen.getByText('1,000.00 THB')).toBeInTheDocument(); // collected this month
    expect(screen.getByText('300.00 THB')).toBeInTheDocument(); // due soon
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
            fyStartDate: '2026-01-01',
          }}
          windowDays={90}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText('4,400,000.00 THB')).toBeInTheDocument();
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
            fyStartDate: '2026-01-01',
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
            fyStartDate: '2026-01-01',
          }}
          windowDays={1}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/within 1 day\b/i)).toBeInTheDocument();
    expect(screen.queryByText(/within 1 days/i)).toBeNull();
  });

  it('renders the four tiles as AURA Stat tiles, in board order', () => {
    renderBand();
    const labels = ['Collection rate', 'Past due', 'Collected this month', 'Due soon'];
    const tiles = labels.map((l) => screen.getByText(l).closest('.aura-stat'));
    for (const tile of tiles) expect(tile).not.toBeNull();
    expect(new Set(tiles).size).toBe(4);
  });

  it('draws no tone on the figures (the board shows them in the text colour)', () => {
    renderBand();
    expect(screen.getByText('79.2%').className).not.toMatch(/text-(success|warning)/);
    expect(screen.getByText('500.00 THB').className).not.toMatch(/text-(success|warning)/);
  });

  it('marks the linked tiles with the arrow icon; the display-only tiles have none', () => {
    renderBand();
    const tileOf = (label: string) => screen.getByText(label).closest('.aura-stat')!;
    expect(tileOf('Past due').querySelector('.aura-stat__icon')).not.toBeNull();
    expect(tileOf('Collected this month').querySelector('.aura-stat__icon')).not.toBeNull();
    expect(tileOf('Collection rate').querySelector('.aura-stat__icon')).toBeNull();
    expect(tileOf('Due soon').querySelector('.aura-stat__icon')).toBeNull();
  });

  // ---- renewals-overdue-prior-fy-subline ----

  it('shows the prior-years sub-line under Past due when overdueBeforeFySatang > 0, with ICU plural ("1 invoice", not "1 invoices")', () => {
    renderBand();
    expect(
      screen.getByText('+ 38,520.00 THB overdue from prior years (1 invoice)'),
    ).toBeInTheDocument();
  });

  it('shows the prior-years sub-line in the danger tone, as the board draws it', () => {
    renderBand();
    const subline = screen.getByRole('link', {
      name: '+ 38,520.00 THB overdue from prior years (1 invoice)',
    });
    expect(subline.className).toContain('text-[var(--aura-fg-danger)]');
  });

  it('renders the sub-line as a drill-down link to the overdue membership invoices list (UX follow-up F3)', () => {
    renderBand();
    // Task 3 (renewals-suspended-visibility-audit) — `status=overdue`
    // (DERIVED: issued + past-due) PLUS `dueBefore` at the SAME
    // SQL-computed fiscal-year boundary the sub-line counted with. The
    // operator rejected the earlier superset landing (all overdue bills);
    // this href now bounds the list to due_date < fyStart = EXACTLY the
    // cohort the sub-line sums.
    expect(
      screen.getByRole('link', {
        name: '+ 38,520.00 THB overdue from prior years (1 invoice)',
      }),
    ).toHaveAttribute(
      'href',
      '/admin/invoices?status=overdue&subject=membership&dueBefore=2026-01-01',
    );
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
            fyStartDate: '2026-01-01',
          }}
          windowDays={90}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(/overdue from prior years/i)).toBeNull();
  });

  it('keeps the prior-years sub-line OUTSIDE the Past-due deep-link (its aria-label would swallow nested text for screen readers)', () => {
    renderBand();
    const subline = screen.getByText('+ 38,520.00 THB overdue from prior years (1 invoice)');
    const pastDueLink = screen.getByRole('link', { name: /past due/i });
    expect(pastDueLink).not.toContainElement(subline);
  });

  it('does not change the Past-due tile main figure or aria-label when the sub-line is present', () => {
    renderBand();
    expect(screen.getByText('500.00 THB')).toBeInTheDocument();
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
      await screen.findByText(/Counts membership invoices DUE in the current fiscal year/),
    ).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(
        screen.queryByText(/Counts membership invoices DUE in the current fiscal year/),
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
      await screen.findByText(/Counts membership invoices DUE in the current fiscal year/),
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

describe('PipelineMoneyBandSkeleton', () => {
  it('reserves the band as four loading AURA Stat tiles under the same heading (CLS 0)', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <PipelineMoneyBandSkeleton />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('heading', { name: en.admin.renewals.money.title })).toBeInTheDocument();
    const tiles = document.querySelectorAll('.aura-stat');
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) expect(tile).toHaveAttribute('aria-busy', 'true');
  });
});
