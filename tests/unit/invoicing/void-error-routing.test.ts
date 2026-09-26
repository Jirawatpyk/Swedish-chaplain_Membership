/**
 * Unit tests for `routeVoidError` — 088 T021a / FR-032.
 *
 * Voiding retires the §87 document number (irreversible-in-effect), so a void
 * FAILURE is surfaced INLINE (focused role=alert), never a transient toast.
 * This pure router classifies the void route's error codes into:
 *   - `concurrent` — a stale-write 409 (`invalid_status`,
 *     `concurrent_state_change`) → inline "already voided — refresh";
 *   - `failure`   — a codeFallback carrying the raw code, or the generic
 *     unknown copy (void has no dedicated operator-actionable message codes).
 *
 * Pure — no framework/DB/network.
 */
import { describe, expect, it } from 'vitest';
import { routeVoidError } from '@/app/(staff)/admin/invoices/[invoiceId]/void/_components/void-error-routing';

describe('routeVoidError (FR-032)', () => {
  it('classifies the 409 stale-write codes as concurrent (refresh, not error)', () => {
    expect(routeVoidError('invalid_status')).toEqual({ kind: 'concurrent' });
    expect(routeVoidError('concurrent_state_change')).toEqual({ kind: 'concurrent' });
  });

  it('every non-concurrent typed code falls back to codeFallback with the raw code', () => {
    for (const code of [
      'invoice_not_found',
      'settings_missing',
      'no_snapshot_on_invoice',
      'pdf_render_failed',
    ]) {
      expect(routeVoidError(code)).toEqual({
        kind: 'failure',
        messageKey: 'errors.codeFallback',
        codeArg: code,
      });
    }
  });

  it('8A — maps refund_in_progress to a DEDICATED message, NOT concurrent nor a raw code dump', () => {
    // A refund is settling on this invoice's payment; voiding now would strand
    // it. The invoice is still voidable (just temporarily blocked), so a
    // dedicated actionable message — not `concurrent` and not `errors.codeFallback`.
    expect(routeVoidError('refund_in_progress')).toEqual({
      kind: 'failure',
      messageKey: 'errors.refundInProgress',
    });
  });

  it('H1 — maps paid_membership_requires_credit_note to a DEDICATED message (redirect to the credit-note workflow)', () => {
    // A paid membership §86/4 can't be voided — it must be reversed via a §86/10
    // credit note. A dedicated actionable message, not `concurrent` (it is not a
    // stale-write) and not a raw `errors.codeFallback` code dump.
    expect(routeVoidError('paid_membership_requires_credit_note')).toEqual({
      kind: 'failure',
      messageKey: 'errors.paidMembershipRequiresCreditNote',
    });
  });

  it('H1 — maps paid_invoice_requires_refund to a DEDICATED message (reverse a paid event with a refund)', () => {
    expect(routeVoidError('paid_invoice_requires_refund')).toEqual({
      kind: 'failure',
      messageKey: 'errors.paidInvoiceRequiresRefund',
    });
  });

  it('a missing code falls back to the generic unknown message', () => {
    expect(routeVoidError(undefined)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
    expect(routeVoidError(null)).toEqual({ kind: 'failure', messageKey: 'errors.unknown' });
  });
});
