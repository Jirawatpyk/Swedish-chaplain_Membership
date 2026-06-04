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
import { db, runInTenant, type TenantTx } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';

/**
 * FR-026 — a permanently-failed F4 auto-email row, surfaced on the invoice
 * detail page so admins can retry / fix the recipient.
 */
export interface FailedAutoEmail {
  readonly outboxRowId: string;
  readonly recipientEmail: string;
  readonly eventType: F4OutboxEventType | null;
  readonly lastError: string | null;
  /** ISO 8601 UTC (from updated_at). */
  readonly failedAt: string;
}

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
      readonly expectedPdfSha256?: string;
      readonly dependsOnReceiptPdf?: boolean;
      readonly privacyFooterKind?: 'event_non_member';
    },
  ): Promise<void> {
    // T107 — `null` tx = "enqueue standalone" (used by resend-pdf,
    // which runs outside a mutating financial tx). Mirrors the
    // `f4AuditAdapter` fallback pattern. `notifications_outbox` had
    // no RLS pre-0098; migration 0098 added FORCE RLS but the
    // BYPASSRLS owner role used by `db` auto-commit + `db.transaction`
    // skips the policy. F1 invitation flow now also stamps a
    // tenant_id (Round-3 Option G).
    const tx = (txUnknown as TenantTx | null) ?? db;
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
      // R17-02 — expected sha256 for dispatcher-side attachment integrity
      // verification (void two-phase commit protection). Dispatcher
      // compares against sha256(prefetchedBytes) before attaching.
      expected_pdf_sha256: input.expectedPdfSha256 ?? null,
      // T166-09 — gates the email dispatch on
      // `invoices.receipt_pdf_status='rendered'`. The dispatcher
      // re-queues the row (without bumping attempts) when the gate is
      // set + the underlying invoice's receipt is still 'pending'.
      depends_on_receipt_pdf: input.dependsOnReceiptPdf ?? false,
      // Task 14 — PDPA privacy-footer discriminator for non-member event
      // invoices. Persisted so a later resend reproduces the same §87/3
      // notice; `null` for membership + matched-member event invoices.
      privacy_footer_kind: input.privacyFooterKind ?? null,
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

/**
 * B7 — which resend variant recovers a failed auto-email: the `invoice_paid`
 * and `receipt_pdf_resent` copies ARE the receipt; everything else (issued,
 * voided, credit-note, invoice-resent) is the invoice copy. Single source of
 * truth for the inverse of resend-pdf's variant→PDF mapping, shared by the
 * detail page (and any future resend-failure surface).
 */
export function resendVariantForFailedEvent(
  eventType: F4OutboxEventType | null,
): 'invoice' | 'receipt' {
  return eventType === 'invoice_paid' || eventType === 'receipt_pdf_resent'
    ? 'receipt'
    : 'invoice';
}

/**
 * FR-026 read (B7) — the permanently-failed `invoice_auto_email` rows for one
 * invoice. Threads `runInTenant` so the FORCE-RLS policy on notifications_outbox
 * (migration 0098) self-scopes the read (never the BYPASSRLS `db` singleton) —
 * with an explicit `tenant_id` filter as belt-and-braces. `pending` rows are
 * still mid-retry and intentionally excluded; `permanently_failed` is the only
 * terminal failure state (bounce / rejection / provider outage all land there).
 * Exported as a standalone read (the detail page imports it directly, the same
 * escape-hatch it already uses for the tenant-settings + credit-note reads) so
 * the EmailOutboxPort interface — and its many enqueue-only fakes — stay
 * untouched.
 */
export async function findFailedAutoEmailsByInvoice(
  invoiceId: string,
  tenantId: string,
): Promise<readonly FailedAutoEmail[]> {
  return runInTenant(asTenantContext(tenantId), async (tx) => {
    const rows = await tx.execute<{
      id: string;
      to_email: string;
      last_error: string | null;
      updated_at: string | Date;
      event_type: string | null;
    }>(sql`
      SELECT id, to_email, last_error, updated_at,
             context_data->>'event_type' AS event_type
      FROM notifications_outbox
      WHERE tenant_id = ${tenantId}
        AND notification_type = 'invoice_auto_email'::notification_type
        AND status = 'permanently_failed'::outbox_status
        AND context_data->>'invoice_id' = ${invoiceId}
      ORDER BY updated_at DESC
      LIMIT 20
    `);
    return rows.map((r) => ({
      outboxRowId: r.id,
      recipientEmail: r.to_email,
      eventType: r.event_type as F4OutboxEventType | null,
      lastError: r.last_error,
      failedAt: new Date(r.updated_at).toISOString(),
    }));
  });
}
