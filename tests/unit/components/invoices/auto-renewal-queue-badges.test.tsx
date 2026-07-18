/**
 * Component tests for `<AutoRenewalQueueBadges>` (107-auto-invoice Task 13,
 * rewritten after the review round that found the signals didn't faithfully
 * represent what would happen if the treasurer clicked Issue).
 *
 * Key invariants under test:
 *   - A2: `refusalReason` renders ITS OWN distinct copy per reason
 *     (plan_year_drift / member_terminated / duplicate_live_bill); only the
 *     duplicate_live_bill reason gets the "View existing bill" link.
 *   - A3: `priceChanged` (confirmed) and `priceUnverifiable` (couldn't
 *     check) are mutually exclusive, DISTINCT badges/copy — never conflated.
 *   - A4: severity ladder — refusalReason(critical/red) > unresolved /
 *     priceUnverifiable(at-risk/orange) > priceChanged(warning/amber) >
 *     billYearStale(healthy/emerald). Asserted via the TIER_CLASSES colour
 *     token actually applied (not just presence).
 *   - A5: price figures render as ALWAYS-VISIBLE text (queue-price-figures),
 *     never tooltip-only.
 *   - A7: the conflicting-invoice link carries the `min-h-11` 44px target
 *     class.
 *   - Every badge pairs an icon with text (WCAG 1.4.1 — colour never alone).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  AutoRenewalQueueBadges,
  type AutoRenewalQueueMeta,
} from '@/app/(staff)/admin/invoices/_components/auto-renewal-queue-badges';

const messages = {
  admin: {
    invoices: {
      list: {
        queue: {
          wouldBeRefused: 'Would be refused',
          wouldBeRefusedAria: 'Would be refused',
          refusalReason: {
            planYearDrift: 'The renewal period changed after this draft was created.',
            memberTerminated: "This member's coverage has lapsed.",
            duplicateLiveBill: 'A bill for this member and plan year already exists.',
          },
          viewConflictingInvoice: 'View existing bill',
          unresolved: 'Unable to verify',
          unresolvedAria: 'Unable to verify this draft',
          unresolvedTooltip:
            "We couldn't confirm this draft's price, coverage, or whether it would be refused.",
          priceUnverifiable: 'Price could not be confirmed',
          priceUnverifiableAria: 'Price could not be confirmed',
          priceFrozenOnly: 'Frozen at {frozen}',
          priceChanged: 'Price changed',
          priceChangedAria: 'Price changed — frozen at {frozen}, current is {current}',
          billYearStale: 'Fiscal year has changed since drafting',
          billYearStaleAria: 'Fiscal year has changed; today is {currentFiscalYear}',
          billYearStaleTooltip:
            'Drafted for fiscal year {planYear}; today is fiscal year {currentFiscalYear}.',
          staleness:
            '{days, plural, =0 {Drafted today} one {Drafted # day ago} other {Drafted # days ago}}',
        },
      },
    },
  },
};

function baseMeta(overrides: Partial<AutoRenewalQueueMeta>): AutoRenewalQueueMeta {
  return {
    unresolved: false,
    stalenessDays: 5,
    frozenPriceDisplay: '45,000.00 THB',
    currentCataloguePriceDisplay: '45,000.00 THB',
    priceChanged: false,
    priceUnverifiable: false,
    planYear: 2026,
    currentFiscalYear: 2026,
    billYearStale: false,
    refusalReason: null,
    ...overrides,
  };
}

function renderBadges(meta: AutoRenewalQueueMeta) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AutoRenewalQueueBadges meta={meta} />
    </NextIntlClientProvider>,
  );
}

describe('<AutoRenewalQueueBadges> — would-be-refused (3 distinct reasons, review A2)', () => {
  it('duplicate_live_bill renders its OWN copy + a 44px "View existing bill" link', () => {
    renderBadges(
      baseMeta({
        refusalReason: { kind: 'duplicate_live_bill', conflictingInvoiceId: 'inv-conflict-1' },
      }),
    );
    const badge = screen.getByTestId('queue-would-be-refused');
    expect(badge).toHaveTextContent('Would be refused');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(
      screen.getByText('A bill for this member and plan year already exists.'),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'View existing bill' });
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-conflict-1');
    // Review A7 — 44×44 minimum tappable target.
    expect(link.className).toContain('min-h-11');
  });

  it('plan_year_drift renders its OWN copy and NO conflicting-invoice link', () => {
    renderBadges(baseMeta({ refusalReason: { kind: 'plan_year_drift' } }));
    expect(screen.getByTestId('queue-would-be-refused')).toBeInTheDocument();
    expect(
      screen.getByText('The renewal period changed after this draft was created.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View existing bill' })).toBeNull();
  });

  it('member_terminated renders its OWN copy and NO conflicting-invoice link', () => {
    renderBadges(baseMeta({ refusalReason: { kind: 'member_terminated' } }));
    expect(screen.getByTestId('queue-would-be-refused')).toBeInTheDocument();
    expect(screen.getByText("This member's coverage has lapsed.")).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View existing bill' })).toBeNull();
  });

  it('refusalReason:null → no would-be-refused badge at all', () => {
    renderBadges(baseMeta({ refusalReason: null }));
    expect(screen.queryByTestId('queue-would-be-refused')).toBeNull();
  });
});

describe('<AutoRenewalQueueBadges> — unresolved suppresses price/bill-year notes', () => {
  it('unresolved=true renders the unresolved badge and SUPPRESSES price/bill-year badges', () => {
    renderBadges(
      baseMeta({
        unresolved: true,
        priceChanged: true,
        priceUnverifiable: true,
        billYearStale: true,
      }),
    );
    const badge = screen.getByTestId('queue-unresolved');
    expect(badge).toHaveTextContent('Unable to verify');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('queue-price-changed')).toBeNull();
    expect(screen.queryByTestId('queue-price-unverifiable')).toBeNull();
    expect(screen.queryByTestId('queue-bill-year-stale')).toBeNull();
  });
});

describe('<AutoRenewalQueueBadges> — price: confirmed-changed vs could-not-confirm are DISTINCT (review A3)', () => {
  it('priceChanged=true renders the CONFIRMED badge with ALWAYS-VISIBLE frozen → current figures (review A5)', () => {
    renderBadges(
      baseMeta({
        priceChanged: true,
        priceUnverifiable: false,
        frozenPriceDisplay: '45,000.00 THB',
        currentCataloguePriceDisplay: '48,000.00 THB',
      }),
    );
    const badge = screen.getByTestId('queue-price-changed');
    expect(badge).toHaveTextContent('Price changed');
    expect(badge.querySelector('svg')).not.toBeNull();
    // The figures are VISIBLE text, not hidden behind a tooltip-only trigger.
    const figures = screen.getByTestId('queue-price-figures');
    expect(figures).toHaveTextContent('45,000.00 THB');
    expect(figures).toHaveTextContent('48,000.00 THB');
    expect(screen.queryByTestId('queue-price-unverifiable')).toBeNull();
  });

  it('priceUnverifiable=true renders the COULD-NOT-CONFIRM badge — distinct testid + copy from priceChanged', () => {
    renderBadges(
      baseMeta({
        priceChanged: false,
        priceUnverifiable: true,
        frozenPriceDisplay: '45,000.00 THB',
        currentCataloguePriceDisplay: null,
      }),
    );
    const badge = screen.getByTestId('queue-price-unverifiable');
    expect(badge).toHaveTextContent('Price could not be confirmed');
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(screen.queryByTestId('queue-price-changed')).toBeNull();
    // Still shows the frozen price it DOES know, as visible text.
    expect(screen.getByTestId('queue-price-figures')).toHaveTextContent(
      '45,000.00 THB',
    );
  });

  it('neither flagged → no price badge at all', () => {
    renderBadges(baseMeta({ priceChanged: false, priceUnverifiable: false }));
    expect(screen.queryByTestId('queue-price-changed')).toBeNull();
    expect(screen.queryByTestId('queue-price-unverifiable')).toBeNull();
  });
});

describe('<AutoRenewalQueueBadges> — bill-year staleness (review A1 redefinition)', () => {
  it('billYearStale=true renders with icon + text', () => {
    renderBadges(baseMeta({ billYearStale: true, currentFiscalYear: 2027 }));
    const badge = screen.getByTestId('queue-bill-year-stale');
    expect(badge).toHaveTextContent('Fiscal year has changed since drafting');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('billYearStale=false (the common case) → no badge — proves this is not an always-on signal', () => {
    renderBadges(baseMeta({ billYearStale: false }));
    expect(screen.queryByTestId('queue-bill-year-stale')).toBeNull();
  });
});

describe('<AutoRenewalQueueBadges> — severity ladder colour tokens (review A4)', () => {
  it('refused=critical(red) > unresolved/priceUnverifiable=at-risk(orange) > priceChanged=warning(amber) > billYearStale=healthy(emerald)', () => {
    renderBadges(
      baseMeta({
        refusalReason: { kind: 'plan_year_drift' },
        priceChanged: true,
        billYearStale: true,
      }),
    );
    expect(screen.getByTestId('queue-would-be-refused').className).toContain('red');
    expect(screen.getByTestId('queue-price-changed').className).toContain('amber');
    expect(screen.getByTestId('queue-bill-year-stale').className).toContain('emerald');
  });

  it('unresolved uses the orange at-risk tier (NOT the faintest styling)', () => {
    renderBadges(baseMeta({ unresolved: true }));
    expect(screen.getByTestId('queue-unresolved').className).toContain('orange');
  });

  it('priceUnverifiable uses the SAME orange at-risk tier as unresolved (both are "uncertain" signals)', () => {
    renderBadges(baseMeta({ priceUnverifiable: true }));
    expect(screen.getByTestId('queue-price-unverifiable').className).toContain('orange');
  });
});

describe('<AutoRenewalQueueBadges> — staleness always renders', () => {
  it('0 days → "Drafted today"', () => {
    renderBadges(baseMeta({ stalenessDays: 0 }));
    expect(screen.getByTestId('queue-staleness')).toHaveTextContent('Drafted today');
  });

  it('1 day → singular "Drafted 1 day ago"', () => {
    renderBadges(baseMeta({ stalenessDays: 1 }));
    expect(screen.getByTestId('queue-staleness')).toHaveTextContent('Drafted 1 day ago');
  });

  it('12 days → plural "Drafted 12 days ago"', () => {
    renderBadges(baseMeta({ stalenessDays: 12 }));
    expect(screen.getByTestId('queue-staleness')).toHaveTextContent('Drafted 12 days ago');
  });

  it('renders even when refused + unresolved are both active', () => {
    renderBadges(
      baseMeta({
        refusalReason: { kind: 'member_terminated' },
        unresolved: true,
        stalenessDays: 3,
      }),
    );
    expect(screen.getByTestId('queue-staleness')).toHaveTextContent('Drafted 3 days ago');
  });
});
