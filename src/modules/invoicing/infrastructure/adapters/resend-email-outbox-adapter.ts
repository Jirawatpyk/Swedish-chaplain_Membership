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
  F4OutboxLocale,
} from '../../application/ports/email-outbox-port';
import type { TenantTx } from '@/lib/db';

export const resendEmailOutboxAdapter: EmailOutboxPort = {
  async enqueue(
    txUnknown,
    input: {
      readonly tenantId: string;
      readonly eventType: F4OutboxEventType;
      readonly recipientEmail: string;
      readonly recipientLocale?: F4OutboxLocale;
      readonly invoiceId?: string;
      readonly creditNoteId?: string;
      readonly pdfBlobKey: string;
      readonly pdfTemplateVersion: number;
      readonly documentNumber?: string;
      readonly voidReason?: string;
    },
  ): Promise<void> {
    const tx = txUnknown as TenantTx;
    const contextData = {
      event_type: input.eventType,
      invoice_id: input.invoiceId ?? null,
      credit_note_id: input.creditNoteId ?? null,
      pdf_blob_key: input.pdfBlobKey,
      pdf_template_version: input.pdfTemplateVersion,
      // FR-036 — snapshotted document number for invoice_voided copy.
      document_number: input.documentNumber ?? null,
      // B-1 — void reason for invoice_voided cancellation email body.
      void_reason: input.voidReason ?? null,
    };
    // R7-S2 — use caller-supplied locale (member's primary-contact
    // preferred_locale when known). Defaults to 'en' for callers
    // that predate the port extension.
    const locale = input.recipientLocale ?? 'en';

    await tx.execute(sql`
      INSERT INTO notifications_outbox
        (tenant_id, notification_type, to_email, locale, context_data, status, attempts, next_retry_at)
      VALUES
        (${input.tenantId},
         'invoice_auto_email'::notification_type,
         ${input.recipientEmail},
         ${locale},
         ${JSON.stringify(contextData)}::jsonb,
         'pending'::outbox_status,
         0,
         now())
    `);
  },
};
