/**
 * <RenewalContextPanel> component spec (New-invoice form renewal-context line).
 *
 * Renders against the REAL en.json (the project's zod-i18n render-test
 * convention — a dangling/renamed key surfaces as MISSING_MESSAGE instead
 * of silently rendering the raw key) with each classification variant
 * passed directly as a prop (no `fetch` mocking needed — the panel is
 * presentational-only; `CreateDraftForm` owns the fetch).
 *
 * The old client-side "duplicate-billing warning" was removed (fixed-anchor
 * migration, 2026-07-22): duplicate detection now lives on the server as
 * `createInvoiceDraft`'s `duplicate_membership_invoice` guard (#243), and the
 * "another paid bill buys a further year" copy was wrong under fixed-anchor.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import {
  RenewalContextPanel,
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
      termMonths: 12,    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'Current period ends 2027-06-01 — paying this bill renews the membership (2027-06-01 to 2028-06-01).',
    );
  });

  it('first_payment — "not active yet" fixed-anchor copy (period fixed, access from payment)', () => {
    renderPanel({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'Membership not active yet — paying this bill activates benefits from the payment date; the 12-month period is fixed to the enrolment date.',
    );
  });

  it('heal_no_cycle — groups under the SAME "not active yet" copy as first_payment', () => {
    renderPanel({
      classification: { kind: 'heal_no_cycle' },
      periodTo: null,
      termMonths: null,    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'Membership not active yet — paying this bill activates benefits from the payment date; the 12-month period is fixed to the enrolment date.',
    );
  });

  it('not_applicable (erased) — reactivation-flow note', () => {
    renderPanel({
      classification: { kind: 'not_applicable', reason: 'erased' },
      periodTo: null,
      termMonths: null,    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'No active membership period — this bill will not affect renewals (use the reactivation flow for lapsed members).',
    );
  });

  it('not_applicable (terminal_only) — same copy as the erased reason', () => {
    renderPanel({
      classification: { kind: 'not_applicable', reason: 'terminal_only' },
      periodTo: null,
      termMonths: null,    });
    expect(screen.getByTestId('renewal-context-line')).toHaveTextContent(
      'No active membership period — this bill will not affect renewals (use the reactivation flow for lapsed members).',
    );
  });

  it('context line pairs an Info icon with text (never colour-alone)', () => {
    renderPanel({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,    });
    const line = screen.getByTestId('renewal-context-line');
    expect(line.querySelector('svg')).not.toBeNull();
    expect(line.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
