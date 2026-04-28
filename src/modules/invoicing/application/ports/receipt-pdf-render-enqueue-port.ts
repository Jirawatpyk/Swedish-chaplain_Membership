/**
 * T166-03 — Receipt PDF render-task enqueue port (F4 / F5 async path).
 *
 * Enqueues a `receipt_pdf_render` notification-outbox row inside the
 * `record-payment` `withTx` so the row commits atomically with
 * `invoices.status='paid'` + `receipt_pdf_status='pending'`. The
 * F4 outbox dispatcher (vercel.json minute-cadence cron) picks it up
 * later, runs `renderReceiptPdf` use-case under
 * `runInTenant(payload.tenantId)`, and flips the row to `'rendered'`.
 *
 * Why a separate port from `EmailOutboxPort`:
 *   - The email outbox row carries `recipientEmail` + `pdfBlobKey`
 *     mandatory fields. A render task has neither at enqueue time
 *     (the blob KEY is computed deterministically; the bytes don't
 *     exist yet). Forcing both into the same port would weaken types
 *     for both consumers.
 *   - The render task is NOT user-visible — it produces bytes that
 *     downstream tasks (the receipt-email outbox row) attach. Distinct
 *     ports = distinct retry budgets + distinct alerts.
 *
 * PCI / tenant isolation:
 *   - `tenantId` is the only routing key the worker needs; the
 *     dispatcher rebinds to `runInTenant(payload.tenantId, …)` before
 *     reading any invoice data, so RLS cross-tenant guarantees hold.
 */
export interface ReceiptPdfRenderEnqueuePort {
  enqueue(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: string;
      readonly fiscalYear: number;
      readonly templateVersion: number;
      /**
       * Required by `notifications_outbox.to_email NOT NULL`. The
       * dispatcher does NOT email this address — render tasks aren't
       * emails. Pass through the member's primary_contact_email from
       * the invoice snapshot (or a sentinel like
       * `'system:async-render@swecham.test'` for legacy rows whose
       * snapshot is missing the field).
       */
      readonly recipientEmail: string;
    },
  ): Promise<void>;
}
