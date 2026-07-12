/**
 * Cluster 5 (Finding 1) — observable auto-email dispatch outcome.
 *
 * The issuance (`issueInvoice`) and payment (`recordPayment`) use-cases
 * auto-enqueue the invoice/receipt email BEST-EFFORT. When the buyer snapshot
 * has no contact email the enqueue is silently skipped — a real gap for
 * imported members with no email on file: the admin was told the operation
 * succeeded and (reasonably) assumed the receipt was emailed.
 *
 * Returning this discriminated outcome makes the skip OBSERVABLE. It does NOT
 * change WHETHER an email sends — only lets the API route + admin toast report
 * that the receipt was NOT sent so the operator can deliver it manually. The
 * operation itself still SUCCEEDS (payment/issue are durable regardless).
 *
 *   - 'sent'             — an outbox row was enqueued (a recipient was present
 *                          AND auto-email was enabled). "Sent" means handed to
 *                          the async dispatcher, not literally delivered yet.
 *   - 'skipped_no_email' — auto-email was enabled but the buyer snapshot has no
 *                          contact email, so nothing was enqueued. The one the
 *                          admin must act on (deliver the receipt manually).
 *   - 'disabled'         — auto-email was intentionally OFF for this document
 *                          (tenant `auto_email_*` setting off, or an F5
 *                          per-payment `suppressReceiptEmail`). No warning.
 */
export type EmailDispatchOutcome = 'sent' | 'skipped_no_email' | 'disabled';
