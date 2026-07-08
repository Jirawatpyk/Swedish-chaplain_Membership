/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b) —
 * <RenewalContextPanel> component spec (New-invoice form renewal-context
 * line + duplicate-billing warning).
 *
 * Renders against the REAL en.json (the project's zod-i18n render-test
 * convention — a dangling/renamed key surfaces as MISSING_MESSAGE instead
 * of silently rendering the raw key) with each classification variant
 * passed directly as a prop (no `fetch` mocking needed — the panel is
 * presentational-only; `CreateDraftForm` owns the fetch).
 *
 * `tests/setup.ts` installs a fixed fake clock (`2026-04-09T12:00:00Z`) by
 * default — used deliberately here to make the ">6 months away" warning
 * threshold deterministic without touching the system clock per-test.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  RenewalContextPanel,
  shouldShowRenewalDuplicateWarning,
  type RenewalContextDto,
} from '@/app/(staff)/admin/invoices/_components/invoice-form';

function renderPanel(context: RenewalContextDto) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RenewalContextPanel context={context} />
    </NextIntlClientProvider>,
  );
}

describe('<RenewalContextPanel> — informational context line (3 classification variants)', () => {
  it('renewal — current period end + the new (from, to) window', () => {
    renderPanel({
      classification: { kind: 'renewal' },
      periodTo: '2027-06-01',
      termMonths: 12,
      hasUnpaidMembershipInvoice: false,
    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'Current period ends 2027-06-01 — paying this bill renews the membership (2027-06-01 to 2028-06-01).',
    );
    // periodTo is intentionally >6 months out here (to exercise the {to}
    // window text) — the duplicate warning it also triggers is covered by
    // its own dedicated test below, not asserted here.
  });

  it('first_payment — "period has not started" copy', () => {
    renderPanel({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,
      hasUnpaidMembershipInvoice: false,
    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'Membership period has not started — paying this bill starts the 12-month period from the payment date.',
    );
  });

  it('heal_no_cycle — groups under the SAME "period has not started" copy as first_payment', () => {
    renderPanel({
      classification: { kind: 'heal_no_cycle' },
      periodTo: null,
      termMonths: null,
      hasUnpaidMembershipInvoice: false,
    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'Membership period has not started — paying this bill starts the 12-month period from the payment date.',
    );
  });

  it('not_applicable (erased) — reactivation-flow note', () => {
    renderPanel({
      classification: { kind: 'not_applicable', reason: 'erased' },
      periodTo: null,
      termMonths: null,
      hasUnpaidMembershipInvoice: false,
    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'No active membership period — this bill will not affect renewals (use the reactivation flow for lapsed members).',
    );
  });

  it('not_applicable (terminal_only) — same copy as the erased reason', () => {
    renderPanel({
      classification: { kind: 'not_applicable', reason: 'terminal_only' },
      periodTo: null,
      termMonths: null,
      hasUnpaidMembershipInvoice: false,
    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'No active membership period — this bill will not affect renewals (use the reactivation flow for lapsed members).',
    );
  });

  it('context line pairs an Info icon with text (never colour-alone)', () => {
    renderPanel({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,
      hasUnpaidMembershipInvoice: false,
    });
    const line = screen.getByTestId('renewal-context-line');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(line.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('<RenewalContextPanel> — duplicate-billing warning (non-blocking, amber)', () => {
  it('shows when an unpaid membership invoice already exists', () => {
    renderPanel({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,
      hasUnpaidMembershipInvoice: true,
    });
    const warning = screen.getByTestId('renewal-duplicate-warning');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning.querySelector('svg')).not.toBeNull();
    expect(warning).toHaveTextContent(/another paid bill buys a further year/);
  });

  it('shows for a renewal-classified member whose period ends more than 6 months away', () => {
    // Fixed clock = 2026-04-09; 2027-06-01 is well past +6 months.
    renderPanel({
      classification: { kind: 'renewal' },
      periodTo: '2027-06-01',
      termMonths: 12,
      hasUnpaidMembershipInvoice: false,
    });
    const warning = screen.getByTestId('renewal-duplicate-warning');
    expect(warning).toHaveTextContent(
      'This member already has an unpaid membership invoice, or their current period runs 2027-06-01 — another paid bill buys a further year.',
    );
  });

  it('does NOT show for a renewal-classified member within the 6-month horizon', () => {
    // Fixed clock = 2026-04-09; 2026-07-01 is under +6 months away.
    renderPanel({
      classification: { kind: 'renewal' },
      periodTo: '2026-07-01',
      termMonths: 12,
      hasUnpaidMembershipInvoice: false,
    });
    expect(screen.queryByTestId('renewal-duplicate-warning')).toBeNull();
  });

  it('does NOT show for a non-renewal member with no unpaid invoice (no false positive)', () => {
    renderPanel({
      classification: { kind: 'heal_no_cycle' },
      periodTo: null,
      termMonths: null,
      hasUnpaidMembershipInvoice: false,
    });
    expect(screen.queryByTestId('renewal-duplicate-warning')).toBeNull();
  });
});

describe('shouldShowRenewalDuplicateWarning — pure condition (spec §3b)', () => {
  const TODAY = '2026-04-09T12:00:00.000Z';

  it('true when hasUnpaidMembershipInvoice, regardless of classification', () => {
    expect(
      shouldShowRenewalDuplicateWarning(
        { classification: { kind: 'not_applicable', reason: 'terminal_only' }, periodTo: null, hasUnpaidMembershipInvoice: true },
        TODAY,
      ),
    ).toBe(true);
  });

  it('true for renewal + periodTo > 6 months away', () => {
    expect(
      shouldShowRenewalDuplicateWarning(
        { classification: { kind: 'renewal' }, periodTo: '2027-06-01', hasUnpaidMembershipInvoice: false },
        TODAY,
      ),
    ).toBe(true);
  });

  it('false for renewal + periodTo within 6 months', () => {
    expect(
      shouldShowRenewalDuplicateWarning(
        { classification: { kind: 'renewal' }, periodTo: '2026-07-01', hasUnpaidMembershipInvoice: false },
        TODAY,
      ),
    ).toBe(false);
  });

  it('false for a non-renewal classification with no unpaid invoice', () => {
    expect(
      shouldShowRenewalDuplicateWarning(
        { classification: { kind: 'first_payment' }, periodTo: null, hasUnpaidMembershipInvoice: false },
        TODAY,
      ),
    ).toBe(false);
  });
});
