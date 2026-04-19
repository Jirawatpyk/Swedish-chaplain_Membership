/**
 * T032 — Email outbox port (F4).
 *
 * Enqueues an outbox row inside the issue/pay/void/CN transaction. The
 * physical dispatcher (Vercel Cron → `dispatch-outbox.ts`) picks up
 * ready rows, invokes Resend, and marks sent / bounced / permanently_failed.
 * Reuses F3's `notifications_outbox` table + dispatcher pattern.
 */

export type F4OutboxEventType =
  | 'invoice_issued'
  | 'invoice_paid'
  | 'invoice_voided'
  | 'credit_note_issued'
  | 'invoice_pdf_resent'
  | 'receipt_pdf_resent'
  | 'credit_note_pdf_resent';

/**
 * R7-S2 — recipient's preferred locale for auto-email rendering.
 * Falls back to 'en' when the caller can't determine the member's
 * preference (e.g. contact has no `preferredLocale` field).
 */
export type F4OutboxLocale = 'en' | 'th' | 'sv';

export interface EmailOutboxPort {
  /**
   * `pdfBlobKey` + `pdfTemplateVersion` are kept as FLAT scalars here
   * (not wrapped in a `pdf: {...}` object like Invoice.pdf) on
   * purpose: the outbox row stores BOTH invoice + receipt variants
   * via `eventType` discrimination, so the caller always knows which
   * PDF to reference at the callsite. A nested object would force
   * the caller to build the right variant per branch — net more
   * boilerplate without added safety. Reviewed 2026-04-19 (M4).
   */
  enqueue(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly eventType: F4OutboxEventType;
      readonly recipientEmail: string;
      /**
       * R7-S2 — recipient locale. Callers SHOULD pass the member's
       * primary contact's `preferred_locale` when available. Defaults
       * to 'en' when omitted (preserves pre-R7-S2 behaviour).
       */
      readonly recipientLocale?: F4OutboxLocale;
      readonly invoiceId?: string;
      readonly creditNoteId?: string;
      readonly pdfBlobKey: string;
      readonly pdfTemplateVersion: number;
    },
  ): Promise<void>;
}
