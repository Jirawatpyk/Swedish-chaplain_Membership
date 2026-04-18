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

export interface EmailOutboxPort {
  enqueue(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly eventType: F4OutboxEventType;
      readonly recipientEmail: string;
      readonly invoiceId?: string;
      readonly creditNoteId?: string;
      readonly pdfBlobKey: string;
      readonly pdfTemplateVersion: number;
    },
  ): Promise<void>;
}
