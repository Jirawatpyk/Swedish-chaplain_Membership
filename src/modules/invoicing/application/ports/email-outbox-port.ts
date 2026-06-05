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
      /**
       * FR-036 — original invoice document number. Rendered into
       * `invoice_voided` email subject/body so the member sees the
       * exact invoice number being cancelled. Optional for other
       * event types (link-based emails ignore it).
       */
      readonly documentNumber?: string;
      /**
       * B-1 / FR-036 — void reason for `invoice_voided` cancellation
       * emails. Spec requires the notice "state the void reason"; the
       * use-case passes the admin-entered free text here. Not persisted
       * in audit (the audit row carries only `void_reason_sha256`);
       * this copy is for the member-facing email body only.
       */
      readonly voidReason?: string;
      /**
       * R17-02 — expected sha256 of the PDF bytes the dispatcher should
       * attach. Populated by `voidInvoice` at enqueue time to protect
       * the two-phase commit: if Phase 2 (post-commit Blob overwrite)
       * fails, the Blob still holds the ORIGINAL un-stamped bytes at
       * `pdfBlobKey` and the dispatcher would otherwise ship them as
       * the "cancellation" attachment. The dispatcher MUST verify
       * `sha256(prefetchedBytes) === expectedPdfSha256` before
       * attaching; on mismatch it permanently-fails the row with
       * `auto_email_delivery_failed` + a distinct reason. Optional for
       * callers that do not attach bytes (issue / paid / CN ship
       * link-only emails today — their Blob-read-verbatim guarantee
       * makes sha pinning redundant).
       */
      readonly expectedPdfSha256?: string;
      /**
       * T166-09 — when `true`, the email dispatcher MUST skip the row
       * (returning to queue without bumping `attempts`) until
       * `invoices.receipt_pdf_status='rendered'`. Set by `recordPayment`
       * on the async path (T166-03 flag on) so the receipt-email row
       * commits inside the same tx as the `paid` flip + `pending`
       * receipt status, but waits for the worker to upload the PDF
       * bytes before sending. Optional — F4-only callers (issue, void,
       * resend, credit-note) leave it `false`/undefined.
       */
      readonly dependsOnReceiptPdf?: boolean;
      /**
       * 054-event-fee-invoices (Task 14) — PDPA privacy-footer
       * discriminator. Set to `'event_non_member'` by `issueInvoice` when
       * the invoice is an EVENT invoice with a non-member buyer
       * (`invoiceSubject === 'event' && memberId === null`); the dispatcher
       * threads it into the email renderer so the §87/3 transparency notice
       * is appended for that buyer only. Omitted/undefined for membership +
       * matched-member event invoices (no extra footer). Persisted on the
       * outbox row's `context_data` so a resend reproduces the same footer.
       */
      readonly privacyFooterKind?: 'event_non_member';
    },
  ): Promise<void>;
}
