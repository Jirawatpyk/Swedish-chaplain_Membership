/**
 * T048 — Resend email outbox adapter (F4).
 *
 * Enqueues a `notifications_outbox` row (F3 pattern) with
 * notification_type='invoice_auto_email' and event-specific context.
 * The dispatcher (T106) reads these rows, renders a @react-email
 * template, attaches the PDF, and invokes Resend.
 */
import { sql } from 'drizzle-orm';
import type {
  EmailOutboxPort,
  F4OutboxEventType,
} from '../../application/ports/email-outbox-port';
import type { TenantTx } from '@/lib/db';

export const resendEmailOutboxAdapter: EmailOutboxPort = {
  async enqueue(
    txUnknown,
    input: {
      readonly tenantId: string;
      readonly eventType: F4OutboxEventType;
      readonly recipientEmail: string;
      readonly invoiceId?: string;
      readonly creditNoteId?: string;
      readonly pdfBlobKey: string;
      readonly pdfTemplateVersion: number;
    },
  ): Promise<void> {
    const tx = txUnknown as TenantTx;
    const contextData = {
      event_type: input.eventType,
      invoice_id: input.invoiceId ?? null,
      credit_note_id: input.creditNoteId ?? null,
      pdf_blob_key: input.pdfBlobKey,
      pdf_template_version: input.pdfTemplateVersion,
    };

    await tx.execute(sql`
      INSERT INTO notifications_outbox
        (tenant_id, notification_type, to_email, locale, context_data, status, attempts, next_retry_at)
      VALUES
        (${input.tenantId},
         'invoice_auto_email'::notification_type,
         ${input.recipientEmail},
         'en',
         ${JSON.stringify(contextData)}::jsonb,
         'pending'::outbox_status,
         0,
         now())
    `);
  },
};
