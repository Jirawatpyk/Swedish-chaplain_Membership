/**
 * Component tests for `<AutoRenewalQueueBadges>` (107-auto-invoice Task 13).
 *
 * This is the auto-renewal review queue's per-row decision-context surface:
 * drift / bill-year-vs-coverage-year / would-be-refused / staleness. The key
 * invariant under test is the RENDERING PRIORITY the task requires:
 *
 *   - "would be refused" is its OWN distinct, destructive-styled state with a
 *     clear reason — never folded into a generic badge set.
 *   - "unresolved" (the F8 context lookup degraded) SUPPRESSES the drift and
 *     bill-year notes (which would be unverifiable) rather than risking a
 *     false-clean signal alongside them.
 *   - drift + bill-year-mismatch can coexist when resolved.
 *   - staleness always renders, independent of every other state.
 *
 * Every state pairs an icon with text (WCAG 1.4.1 — colour is never the only
 * signal), asserted via `data-testid` + visible text together.
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
          wouldBeRefusedAria:
            'Would be refused — a live bill for this member and plan year already exists',
          viewConflictingInvoice: 'View existing bill',
          unresolved: 'Unable to verify',
          unresolvedTooltip: 'Could not verify.',
          drift: 'Price changed',
          driftAria: 'Price changed — frozen at {frozen} THB, current catalogue price is {current} THB',
          driftTooltip: 'Frozen at {frozen} THB; current catalogue price is {current} THB.',
          driftTooltipUnknown: 'Could not confirm.',
          billYearMismatch: 'Bill year ≠ coverage year',
          billYearMismatchTooltip: 'This bill is for fiscal year {coverageYear}.',
          billYearMismatchTooltipUnknown: 'Coverage year unknown.',
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
    driftFlagged: false,
    frozenPriceThb: '50000.00',
    currentCataloguePriceThb: '50000.00',
    billYearCoverageYearMismatch: false,
    coverageYear: 2026,
    wouldBeRefused: false,
    conflictingInvoiceId: null,
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

describe('<AutoRenewalQueueBadges> — would-be-refused (distinct state)', () => {
  it('renders the would-be-refused badge with icon + text + a link to the conflicting invoice', () => {
    renderBadges(
      baseMeta({ wouldBeRefused: true, conflictingInvoiceId: 'inv-conflict-1' }),
    );
    const badge = screen.getByTestId('queue-would-be-refused');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Would be refused');
    // WCAG 1.4.1 — icon present, not colour alone.
    expect(badge.querySelector('svg')).not.toBeNull();
    expect(badge).toHaveAttribute(
      'aria-label',
      'Would be refused — a live bill for this member and plan year already exists',
    );
    const link = screen.getByRole('link', { name: 'View existing bill' });
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-conflict-1');
  });

  it('does NOT render the would-be-refused badge when false', () => {
    renderBadges(baseMeta({ wouldBeRefused: false }));
    expect(screen.queryByTestId('queue-would-be-refused')).toBeNull();
    expect(screen.queryByRole('link', { name: 'View existing bill' })).toBeNull();
  });

  it('omits the conflicting-invoice link when conflictingInvoiceId is null (defensive)', () => {
    renderBadges(baseMeta({ wouldBeRefused: true, conflictingInvoiceId: null }));
    expect(screen.getByTestId('queue-would-be-refused')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View existing bill' })).toBeNull();
  });

  it('would-be-refused CAN coexist with drift + bill-year-mismatch notes below it', () => {
    renderBadges(
      baseMeta({
        wouldBeRefused: true,
        conflictingInvoiceId: 'inv-conflict-2',
        driftFlagged: true,
        billYearCoverageYearMismatch: true,
      }),
    );
    expect(screen.getByTestId('queue-would-be-refused')).toBeInTheDocument();
    expect(screen.getByTestId('queue-drift')).toBeInTheDocument();
    expect(screen.getByTestId('queue-bill-year-mismatch')).toBeInTheDocument();
  });
});

describe('<AutoRenewalQueueBadges> — unresolved suppresses drift/bill-year notes', () => {
  it('unresolved=true renders the unresolved badge and SUPPRESSES drift/mismatch even if flagged', () => {
    renderBadges(
      baseMeta({
        unresolved: true,
        driftFlagged: true,
        billYearCoverageYearMismatch: true,
        frozenPriceThb: null,
        currentCataloguePriceThb: null,
        coverageYear: null,
      }),
    );
    const unresolved = screen.getByTestId('queue-unresolved');
    expect(unresolved).toBeInTheDocument();
    expect(unresolved).toHaveTextContent('Unable to verify');
    expect(unresolved.querySelector('svg')).not.toBeNull();
    // Never a false-clean OR a conflicting drift/mismatch signal alongside it.
    expect(screen.queryByTestId('queue-drift')).toBeNull();
    expect(screen.queryByTestId('queue-bill-year-mismatch')).toBeNull();
  });
});

describe('<AutoRenewalQueueBadges> — drift + bill-year-mismatch (resolved)', () => {
  it('driftFlagged=true (resolved) renders the drift badge with icon + text', () => {
    renderBadges(
      baseMeta({ driftFlagged: true, frozenPriceThb: '50000.00', currentCataloguePriceThb: '60000.00' }),
    );
    const badge = screen.getByTestId('queue-drift');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Price changed');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('driftFlagged=false → no drift badge', () => {
    renderBadges(baseMeta({ driftFlagged: false }));
    expect(screen.queryByTestId('queue-drift')).toBeNull();
  });

  it('billYearCoverageYearMismatch=true renders the bill-year note with icon + text', () => {
    renderBadges(baseMeta({ billYearCoverageYearMismatch: true, coverageYear: 2027 }));
    const badge = screen.getByTestId('queue-bill-year-mismatch');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Bill year ≠ coverage year');
    expect(badge.querySelector('svg')).not.toBeNull();
  });

  it('drift and bill-year-mismatch render TOGETHER when both flagged', () => {
    renderBadges(baseMeta({ driftFlagged: true, billYearCoverageYearMismatch: true }));
    expect(screen.getByTestId('queue-drift')).toBeInTheDocument();
    expect(screen.getByTestId('queue-bill-year-mismatch')).toBeInTheDocument();
  });

  it('neither flagged → no drift/mismatch badges, resolved state renders no unresolved badge either', () => {
    renderBadges(baseMeta({}));
    expect(screen.queryByTestId('queue-drift')).toBeNull();
    expect(screen.queryByTestId('queue-bill-year-mismatch')).toBeNull();
    expect(screen.queryByTestId('queue-unresolved')).toBeNull();
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

  it('staleness renders even when wouldBeRefused + unresolved are both active', () => {
    renderBadges(
      baseMeta({ wouldBeRefused: true, unresolved: true, stalenessDays: 3 }),
    );
    expect(screen.getByTestId('queue-staleness')).toHaveTextContent('Drafted 3 days ago');
  });
});
