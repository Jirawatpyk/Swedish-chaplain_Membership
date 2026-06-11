/**
 * Wave-4 S15 — shared auto-email outbox enqueue for the two ISSUANCE-shaped
 * call sites (`issueInvoice` step L and `issueEventInvoiceAsPaid` step L),
 * which previously duplicated the same trim → skip-with-warn+metric →
 * enqueue-with-optional-PDPA-footer block verbatim.
 *
 * Behaviour (extracted byte-identical from both callers):
 *   - the recipient comes from the BUYER snapshot and may be '' for a
 *     non-member event buyer (§86/4: a contact is supplementary) — trim it
 *     and SKIP the enqueue on empty, logging ids only (NO email/PII per
 *     CLAUDE.md § Secrets) plus the `autoEmailSkipped` metric so ops can
 *     alert on the otherwise-silent skip;
 *   - otherwise enqueue ONE outbox row inside the caller's open tx. An
 *     `enqueue` THROW intentionally propagates — both callers treat it as a
 *     tx-rollback failure (the email row and the issuance/paid row commit
 *     atomically or not at all); only the empty-recipient SKIP is
 *     best-effort.
 *
 * recordPayment's receipt-email block is DELIBERATELY NOT folded in here —
 * its semantics differ in four load-bearing ways (see the pointer comment at
 * its call site): an F5 `suppressReceiptEmail` three-arm branch with an
 * info-log arm, the `dependsOnReceiptPdf` async-PDF gate, a NON-trimmed
 * recipient check, and a differently-shaped skip warn.
 */
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import type { InvoiceId } from '@/modules/invoicing/domain/invoice';
import type { EmailOutboxPort, F4OutboxEventType } from '../ports/email-outbox-port';

export interface EnqueueInvoiceAutoEmailArgs {
  readonly tenantId: string;
  readonly invoiceId: InvoiceId;
  /** For the skip metric + skip-warn context (`autoEmailSkipped(subject, …)`). */
  readonly invoiceSubject: 'membership' | 'event';
  readonly eventType: Extract<F4OutboxEventType, 'invoice_issued' | 'invoice_paid'>;
  /** Raw buyer-snapshot email — trimmed here; ''/null after trim → skip. */
  readonly recipientEmail: string | null;
  readonly pdfBlobKey: string;
  readonly pdfTemplateVersion: number;
  /** §87/3 PDPA transparency footer (non-member event buyer only). */
  readonly privacyFooterKind?: 'event_non_member' | undefined;
  /** Caller-specific human text for the skip warn (structured fields are fixed). */
  readonly skipLogMessage: string;
}

export async function enqueueInvoiceAutoEmail(
  outbox: EmailOutboxPort,
  tx: unknown,
  args: EnqueueInvoiceAutoEmailArgs,
): Promise<void> {
  const recipientEmail = (args.recipientEmail ?? '').trim();
  if (recipientEmail === '') {
    invoicingMetrics.autoEmailSkipped(args.invoiceSubject, 'no_recipient');
    logger.warn(
      {
        event: 'invoice_auto_email_skipped_no_recipient',
        tenantId: args.tenantId,
        invoiceId: args.invoiceId,
        invoiceSubject: args.invoiceSubject,
      },
      args.skipLogMessage,
    );
    return;
  }
  await outbox.enqueue(tx, {
    tenantId: args.tenantId,
    eventType: args.eventType,
    recipientEmail,
    invoiceId: args.invoiceId,
    pdfBlobKey: args.pdfBlobKey,
    pdfTemplateVersion: args.pdfTemplateVersion,
    ...(args.privacyFooterKind ? { privacyFooterKind: args.privacyFooterKind } : {}),
  });
}
