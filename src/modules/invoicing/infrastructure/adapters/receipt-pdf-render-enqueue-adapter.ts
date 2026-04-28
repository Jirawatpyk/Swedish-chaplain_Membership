/**
 * T166-03/07 — Receipt-PDF render-task outbox adapter (F4).
 *
 * Inserts a `notifications_outbox` row with
 * `notification_type='receipt_pdf_render'` so the F4 dispatcher cron
 * (`/api/cron/outbox-dispatch`) can route it to the
 * `renderReceiptPdf` use-case under
 * `runInTenant(payload.tenantId)`.
 *
 * Why a separate adapter from `resend-email-outbox-adapter.ts`:
 *   The shape of `context_data` is different (no `event_type` or
 *   `pdf_blob_key` — those are computed by the worker), and the
 *   dispatcher routes on `notification_type` BEFORE peeking at
 *   context. Same Postgres table, distinct row schema.
 */
import { sql } from 'drizzle-orm';

import type { ReceiptPdfRenderEnqueuePort } from '../../application/ports/receipt-pdf-render-enqueue-port';
import { db, type TenantTx } from '@/lib/db';

export const receiptPdfRenderEnqueueAdapter: ReceiptPdfRenderEnqueuePort = {
  async enqueue(txUnknown, input): Promise<void> {
    // `null` tx → standalone enqueue (best-effort). Mirrors the
    // F4 email outbox adapter's `null tx → db` fallback. The
    // `record-payment.ts` callsite always passes the active webhook
    // tx so the row commits atomically with `status='paid'` +
    // `receipt_pdf_status='pending'`.
    const tx = (txUnknown as TenantTx | null) ?? db;
    const contextData = {
      // Worker reads these to re-hydrate the render input.
      invoice_id: input.invoiceId,
      fiscal_year: input.fiscalYear,
      template_version: input.templateVersion,
    };

    await tx.execute(sql`
      INSERT INTO notifications_outbox
        (tenant_id, notification_type, to_email, locale, context_data, status, attempts, next_retry_at)
      VALUES
        (${input.tenantId},
         'receipt_pdf_render'::notification_type,
         ${input.recipientEmail},
         'en',
         ${JSON.stringify(contextData)}::jsonb,
         'pending'::outbox_status,
         0,
         now())
    `);
  },
};
