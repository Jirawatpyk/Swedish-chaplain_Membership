/**
 * T039 — get-invoice-pdf-signed-url use case (F4).
 *
 * Ownership check + 60 s signed URL. Emits `invoice_cross_tenant_probe`
 * when a session attempts to read an invoice they don't own. For
 * admin/manager: probe = cross-tenant (different `tenant_id`). For
 * member: probe = different `member_id`.
 *
 * Blob-miss handling: R9-E1 added try/catch around `signDownloadUrl`
 * that maps `BlobNotFoundError` to a typed `blob_missing` Result with
 * the stored key — route handler surfaces 502 + the key for operator
 * triage, instead of letting the throw fall to the route-level catch
 * and serving a generic 500. Auto-rerender on Blob-miss (re-render
 * with the PINNED `pdf_template_version` for byte-identical recovery)
 * remains deferred — see TODO below + T113a in the retrospective.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import {
  asInvoiceId,
  billFirstDocumentNumber,
  type InvoiceId,
} from '@/modules/invoicing/domain/invoice';

export interface GetInvoicePdfSignedUrlInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager' | 'member';
  /** For members only — the member_id they are allowed to see. */
  readonly actorMemberId?: string;
  readonly requestId?: string | null;
  readonly invoiceId: string;
}

export type GetInvoicePdfSignedUrlError =
  | { code: 'invoice_not_found' }
  | { code: 'forbidden' }
  | { code: 'blob_missing'; key: string }
  // T166-10 — async receipt PDF render in flight. Member-scope only:
  // a paid invoice is being post-processed by the worker (status
  // !=='rendered'). Route layer maps this to HTTP 425 Too Early +
  // Retry-After: 30. Admin/manager continue to receive the invoice
  // variant byte stream as before (they can preview before receipt
  // stamping completes).
  | { code: 'receipt_pdf_pending'; retryAfterSeconds: number };

export interface GetInvoicePdfSignedUrlDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
}

export async function getInvoicePdfSignedUrl(
  deps: GetInvoicePdfSignedUrlDeps,
  input: GetInvoicePdfSignedUrlInput,
): Promise<Result<{ url: string; filename: string }, GetInvoicePdfSignedUrlError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const invoice = await deps.invoiceRepo.findById(invoiceId, input.tenantId);

  if (!invoice) {
    // Could be cross-tenant probe OR genuinely missing id. We emit
    // the audit either way — the actor_tenant_id is in the row.
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_cross_tenant_probe',
      actorUserId: input.actorUserId,
      summary: `Probe on invoice ${invoiceId} (not found in actor tenant)`,
      payload: {
        attempted_invoice_id: invoiceId,
        actor_role: input.actorRole,
        route: 'get-invoice-pdf-signed-url',
      },
    });
    return err({ code: 'invoice_not_found' });
  }

  // Members can only see their own company's invoices.
  if (input.actorRole === 'member') {
    if (!input.actorMemberId || invoice.memberId !== input.actorMemberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Member probe on non-owned invoice ${invoiceId}`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_member_id: input.actorMemberId ?? null,
          invoice_member_id: invoice.memberId,
          actor_role: 'member',
        },
      });
      return err({ code: 'forbidden' });
    }
  }

  // Drafts have no PDF yet — refuse.
  if (!invoice.pdf) return err({ code: 'forbidden' });

  // T166-10 — async receipt-PDF gate (member-scope). When the
  // record-payment use-case ran with `asyncReceiptPdf=true`, the
  // invoice flips to `paid` synchronously but the receipt-stamped
  // PDF is rendered by the cron worker (out-of-band). Until the
  // worker completes, expose 425 Too Early + Retry-After to the
  // member's portal page so it can render a polite "preparing…"
  // state with `aria-busy="true"`. Admin/manager keep the existing
  // byte stream — they can re-issue/preview without waiting for
  // the receipt stamp.
  if (
    input.actorRole === 'member' &&
    invoice.status === 'paid' &&
    invoice.receiptPdfStatus !== null &&
    invoice.receiptPdfStatus !== 'rendered'
  ) {
    return err({ code: 'receipt_pdf_pending', retryAfterSeconds: 30 });
  }

  // TODO(F4-T113a): auto-rerender on Blob-miss. Today we return
  // `blob_missing` (the route maps to 502); future enhancement is to
  // re-render with the PINNED `pdf_template_version` for byte-identical
  // recovery + emit `invoice_pdf_regenerated`. See migration 0030
  // + retrospective § "PDF Reproducibility — Best Practice Decision".

  // R8-M1-code — audit emit BEFORE signing the URL. The audit is the
  // durable §87 forensic trail; if it fails (Neon transient, retention
  // column constraint) we MUST fail the read entirely rather than
  // serve a download whose access record cannot be reconstructed.
  // Closes the audit-coverage asymmetry: receipts already logged
  // downloads via `receipt_pdf_downloaded`; invoices previously had
  // no equivalent on the success path.
  await deps.audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId ?? null,
    eventType: 'invoice_pdf_downloaded',
    actorUserId: input.actorUserId,
    summary: `Invoice PDF downloaded — ${billFirstDocumentNumber(invoice) ?? invoiceId}`,
    payload: {
      invoice_id: invoiceId,
      member_id: invoice.memberId,
      actor_member_id:
        input.actorRole === 'member'
          ? (input.actorMemberId ?? null)
          : null,
      invoice_pdf_template_version: invoice.pdf.templateVersion,
      actor_role: input.actorRole,
      route: 'get-invoice-pdf-signed-url',
    },
  });

  // R9-E1 — wrap signDownloadUrl in try/catch parity with the CN
  // sibling (`get-credit-note-pdf-signed-url.ts:99-115`). Vercel Blob
  // SDK throws `BlobNotFoundError` when the key is gone (orphan
  // sweeper, deleted bucket, half-committed past tx). Map to the typed
  // `blob_missing` Result so the route handler surfaces 502 with the
  // operator-actionable key, instead of a generic 500 that buries the
  // root cause beneath the route-level try/catch.
  let url: string;
  try {
    url = await deps.blob.signDownloadUrl(invoice.pdf.blobKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const notFound = /not found|404|BlobNotFoundError/i.test(msg);
    logger.error(
      {
        err: msg,
        invoiceId,
        tenantId: input.tenantId,
        blobKey: invoice.pdf.blobKey,
        notFound,
      },
      'getInvoicePdfSignedUrl: blob sign failed',
    );
    if (notFound) return err({ code: 'blob_missing', key: invoice.pdf.blobKey });
    throw e;
  }
  // 088 (FR-030) — an issued ใบแจ้งหนี้ bill carries its number in
  // `billDocumentNumberRaw` (`document_number` is NULL until payment), so read
  // it FIRST — otherwise the download filename falls back to the generic
  // "invoice.pdf" instead of e.g. "SC-2026-000001.pdf". Legacy §87 rows (bill
  // number NULL) fall through to `documentNumber`.
  const filename = `${billFirstDocumentNumber(invoice) ?? 'invoice'}.pdf`;
  return ok({ url, filename });
}
