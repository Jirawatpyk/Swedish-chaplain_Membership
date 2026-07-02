/**
 * 088 US8 UX-B1 (T061e-3) — `getZeroRateCertSignedUrl` Application use-case.
 *
 * Admin-only retrievability of the 10y-retained §80/1(5) zero-rate certificate
 * SCAN pinned on an issued invoice (FR-024: "retained separately, 10y,
 * admin-only"). Cloned from `get-invoice-pdf-signed-url.ts`:
 *   - ownership check (admin/manager only — there is NO member scope for the
 *     cert scan, which is staff-only supporting evidence);
 *   - emits an `invoice_pdf_downloaded`-style audit BEFORE signing (durable
 *     forensic trail — the read fails if the audit fails);
 *   - `blob.signDownloadUrl` on the invoice's pinned `zeroRateCertBlobKey`,
 *     with `BlobNotFoundError` mapped to a typed `blob_missing` Result.
 *
 * AUDIT NOTE: reuses the existing `invoice_pdf_downloaded` event type (10y
 * retention, tax-document class) with a `document:'zero_rate_cert'` +
 * `route` discriminator and NO `member_id` (so a staff cert-view never
 * pollutes a member's F3 timeline). This honours the task's
 * "invoice_pdf_downloaded-style" instruction while avoiding a heavy new
 * event-type (4-place) change. A dedicated `zero_rate_cert_downloaded` type is
 * a reviewer-discretion follow-up.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import { asInvoiceId, type InvoiceId } from '@/modules/invoicing/domain/invoice';

export interface GetZeroRateCertSignedUrlInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  /** Staff-only — the cert scan is admin/manager evidence, never member-facing. */
  readonly actorRole: 'admin' | 'manager';
  readonly requestId?: string | null;
  readonly invoiceId: string;
}

export type GetZeroRateCertSignedUrlError =
  | { code: 'invoice_not_found' }
  /** The invoice exists but has no cert scan attached (cert NUMBER-only issue). */
  | { code: 'cert_not_attached' }
  | { code: 'blob_missing'; key: string };

export interface GetZeroRateCertSignedUrlDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
}

/** Derive a download filename extension from the stored blob key. */
function extFromKey(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot === -1 || dot === key.length - 1) return 'bin';
  return key.slice(dot + 1).toLowerCase();
}

export async function getZeroRateCertSignedUrl(
  deps: GetZeroRateCertSignedUrlDeps,
  input: GetZeroRateCertSignedUrlInput,
): Promise<Result<{ url: string; filename: string }, GetZeroRateCertSignedUrlError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const invoice = await deps.invoiceRepo.findById(invoiceId, input.tenantId);

  if (!invoice) {
    // RLS-hidden cross-tenant row looks identical to a genuinely-missing id —
    // audit either way (Constitution Principle I clause 4). `null` tx: read path.
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_cross_tenant_probe',
      actorUserId: input.actorUserId,
      summary: `Probe on invoice ${invoiceId} (not found — zero-rate cert view)`,
      payload: {
        attempted_invoice_id: invoiceId,
        actor_role: input.actorRole,
        route: 'get-zero-rate-cert-signed-url',
      },
    });
    return err({ code: 'invoice_not_found' });
  }

  if (!invoice.zeroRateCertBlobKey) {
    return err({ code: 'cert_not_attached' });
  }

  // 088 US8 UX-B1 review fix (defense-in-depth) — issue-invoice validates the
  // pinned key's namespace at pin time, but re-verify HERE before signing so a
  // legacy/mispinned row can never make this admin proxy sign + stream an
  // arbitrary or cross-tenant blob (Vercel Blob has no RLS → this is the
  // tenant-isolation boundary, Constitution I). The key MUST be under THIS
  // tenant + invoice's server-derived cert prefix.
  if (
    !invoice.zeroRateCertBlobKey.startsWith(
      `invoicing/${input.tenantId}/zero-rate-certs/${input.invoiceId}_`,
    )
  ) {
    return err({ code: 'cert_not_attached' });
  }

  // Audit BEFORE signing — the durable forensic trail for a 10y admin-only
  // tax-document touch. If the audit fails (Neon transient), fail the read
  // rather than serve a download whose access record cannot be reconstructed.
  await deps.audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId ?? null,
    eventType: 'invoice_pdf_downloaded',
    actorUserId: input.actorUserId,
    summary: `Zero-rate cert scan downloaded — ${
      invoice.documentNumber?.raw ?? invoice.billDocumentNumberRaw ?? invoiceId
    }`,
    payload: {
      invoice_id: invoiceId,
      // `document` discriminator + NO member_id → forensic-only, not on the
      // F3 member timeline (which keys on `payload->>'member_id'`).
      document: 'zero_rate_cert',
      actor_role: input.actorRole,
      route: 'get-zero-rate-cert-signed-url',
    },
  });

  let url: string;
  try {
    url = await deps.blob.signDownloadUrl(invoice.zeroRateCertBlobKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const notFound = /not found|404|BlobNotFoundError/i.test(msg);
    logger.error(
      {
        err: msg,
        invoiceId,
        tenantId: input.tenantId,
        blobKey: invoice.zeroRateCertBlobKey,
        notFound,
      },
      'getZeroRateCertSignedUrl: blob sign failed',
    );
    if (notFound) return err({ code: 'blob_missing', key: invoice.zeroRateCertBlobKey });
    throw e;
  }

  const label = invoice.documentNumber?.raw ?? invoice.billDocumentNumberRaw ?? invoiceId;
  const filename = `zero-rate-cert-${label}.${extFromKey(invoice.zeroRateCertBlobKey)}`;
  return ok({ url, filename });
}
