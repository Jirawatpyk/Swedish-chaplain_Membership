/**
 * REMOVE-WITH-064-REMEDIATION (online-payment site 13/15 — master checklist
 * at the guard in record-payment.ts +
 * docs/runbooks/event-invoice-legacy-no-tin-remediation.md).
 *
 * 065 review follow-up — the portal pay-gate predicate, extracted from the
 * inline expression in `[invoiceId]/page.tsx` so the OVER-match arm has a
 * unit-test backstop (tests/unit/portal/legacy-no-tin.test.ts): if this
 * predicate ever drifts to match MORE rows than the record-payment guard,
 * every TIN event invoice silently loses its Pay-now button — an
 * availability regression no server-side test would catch, because the
 * server guard itself stays correct.
 *
 * A LEGACY pre-064 issued no-TIN EVENT invoice must not surface the Pay-now
 * button: its issue-time PDF already IS the §105 receipt, and a Stripe
 * payment against it gets captured but never applied (the webhook-side
 * `recordPayment` guard rejects the flip with no auto-refund — S0 money
 * trap). The F4 payability read (`getInvoiceForPayment`) + the initiate
 * route reject it server-side; this predicate is the matching member-facing
 * surface, replaced by a localized "under document correction — contact
 * staff" notice on the page. Mirrors the record-payment guard predicate
 * exactly (subject + issued + trimmed-TIN check via the shared Domain
 * `buyerHasTin`). A NULL buyer snapshot fails closed (treated as no-TIN):
 * the page must never offer Pay-now on a row whose buyer it cannot verify.
 */
import type { Invoice } from '@/modules/invoicing';
import { buyerHasTin } from '@/modules/invoicing';

/**
 * True iff the invoice is a LEGACY pre-064 issued no-TIN EVENT row — the
 * only class of issued invoice the portal must not offer online payment
 * for. Pure; accepts the structural subset so unit tests need no full
 * `Invoice` fixture.
 */
export function isLegacyNoTinEventInvoice(
  invoice: Pick<Invoice, 'invoiceSubject' | 'status' | 'memberIdentitySnapshot'>,
): boolean {
  return (
    invoice.invoiceSubject === 'event' &&
    invoice.status === 'issued' &&
    !buyerHasTin(invoice.memberIdentitySnapshot?.tax_id)
  );
}
