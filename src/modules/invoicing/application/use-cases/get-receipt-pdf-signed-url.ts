/**
 * get-receipt-pdf-signed-url use case (F4 — admin receipt-PDF surface).
 *
 * Mirrors `get-invoice-pdf-signed-url` but resolves to the receipt PDF.
 * The system ALWAYS persists two distinct physical PDFs per paid
 * invoice:
 *   - `invoice.pdf` — rendered at `issueInvoice`. In the 088 bill→RC flow
 *     (FEATURE_088_TAX_AT_PAYMENT) its header is the NON-tax "ใบแจ้งหนี้ /
 *     Invoice"; on the legacy flag-off path it is "ใบกำกับภาษี / Tax Invoice".
 *   - `invoice.receiptPdf` — rendered at `recordPayment`, the §86/4 payment-time
 *     "ใบกำกับภาษี / ใบเสร็จรับเงิน" tax receipt (or the §105 "ใบเสร็จรับเงิน /
 *     Official Receipt" for an event-without-TIN buyer).
 *
 * Behaviour keys off whether a distinct §87 receipt number was minted —
 * `receiptDocumentNumberRaw` (the `RC` in the new flow; NULL only on the legacy
 * reuse path where the receipt reuses the §87 invoice number) — plus
 * `receiptPdfStatus`. (The retired `receiptNumberingMode` setting no longer
 * drives this — F.5 / T008.)
 *
 *   RC set + paid + rendered           → invoice.receiptPdf.blobKey
 *                                        filename = {RC-2026-0001}.pdf
 *   reuse (RC NULL) + paid + rendered  → invoice.receiptPdf.blobKey
 *                                        filename = {invoiceDocNum}-receipt.pdf
 *                                        (distinguishes from the sibling PDF)
 *   paid + pending                     → 'receipt_pdf_pending' (425 to
 *                                        member; admin gets fallback to
 *                                        invoice.pdf — see admin route)
 *   paid + failed                      → 'receipt_pdf_failed' with
 *                                        `receiptPdfLastError` in payload
 *                                        (admin only — strip for member)
 *   non-paid / draft / void / credited → 'forbidden'
 *
 * Ownership matches `getInvoicePdfSignedUrl` — admin/manager see any
 * invoice in their tenant; member sees only invoices on their own
 * `member_id`. Cross-tenant probes reuse `invoice_cross_tenant_probe`
 * (receipt is a sub-resource per F4 audit-port convention; a separate
 * `receipt_cross_tenant_probe` would double-emit). On success, emits
 * `receipt_pdf_downloaded` (10-year retention per Thai RD §87/3).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import { asInvoiceId, type InvoiceId } from '@/modules/invoicing/domain/invoice';

export interface GetReceiptPdfSignedUrlInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager' | 'member';
  /** For members only — the member_id they are allowed to see. */
  readonly actorMemberId?: string;
  readonly requestId?: string | null;
  readonly invoiceId: string;
}

export type GetReceiptPdfSignedUrlError =
  | { code: 'invoice_not_found' }
  | { code: 'forbidden' }
  | { code: 'blob_missing'; key: string }
  // Async receipt-PDF render in flight (separate-mode). Same gate as
  // `getInvoicePdfSignedUrl`. Member-scope only — route maps to 425.
  | { code: 'receipt_pdf_pending'; retryAfterSeconds: number }
  // Worker exhausted retry budget. `receiptPdfLastError` carries the
  // failure reason for the admin UI; member surface strips it.
  | { code: 'receipt_pdf_failed'; reason: string | null };

export interface GetReceiptPdfSignedUrlDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
}

export async function getReceiptPdfSignedUrl(
  deps: GetReceiptPdfSignedUrlDeps,
  input: GetReceiptPdfSignedUrlInput,
): Promise<Result<{ url: string; filename: string }, GetReceiptPdfSignedUrlError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const invoice = await deps.invoiceRepo.findById(invoiceId, input.tenantId);

  if (!invoice) {
    // Reuse `invoice_cross_tenant_probe` — receipt is a sub-resource of
    // invoice, so the probe applies to the parent entity ownership.
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_cross_tenant_probe',
      actorUserId: input.actorUserId,
      summary: `Probe on invoice ${invoiceId} (receipt PDF, not found in actor tenant)`,
      payload: {
        attempted_invoice_id: invoiceId,
        actor_role: input.actorRole,
        route: 'get-receipt-pdf-signed-url',
      },
    });
    return err({ code: 'invoice_not_found' });
  }

  // Member-scope ownership check.
  if (input.actorRole === 'member') {
    if (!input.actorMemberId || invoice.memberId !== input.actorMemberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Member probe on non-owned invoice ${invoiceId} (receipt PDF)`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_member_id: input.actorMemberId ?? null,
          invoice_member_id: invoice.memberId,
          actor_role: 'member',
          route: 'get-receipt-pdf-signed-url',
        },
      });
      return err({ code: 'forbidden' });
    }
  }

  // Only paid invoices have a receipt. Drafts / issued / void / credited
  // / partially_credited → forbidden (no receipt to download).
  if (invoice.status !== 'paid') return err({ code: 'forbidden' });

  // Member 425 gate — identical to `getInvoicePdfSignedUrl`. The receipt
  // worker is mid-flight; ask the client to back off and re-poll.
  if (
    input.actorRole === 'member' &&
    invoice.receiptPdfStatus !== null &&
    invoice.receiptPdfStatus !== 'rendered'
  ) {
    return err({ code: 'receipt_pdf_pending', retryAfterSeconds: 30 });
  }

  // Receipt worker permanently failed (3 retries exhausted). Surface the
  // reason for admin so they can take corrective action (re-render via
  // the resend route or a future "Retry render" admin button).
  if (invoice.receiptPdfStatus === 'failed') {
    return err({
      code: 'receipt_pdf_failed',
      reason: invoice.receiptPdfLastError ?? null,
    });
  }

  // Resolve which blob key + filename to serve.
  //
  // The receipt PDF is ALWAYS a distinct physical file from the invoice
  // PDF — `recordPayment` renders it with kind='receipt_combined'
  // (combined-mode, header "ใบกำกับภาษี / ใบเสร็จรับเงิน") or
  // kind='receipt_separate' (header "ใบเสร็จรับเงิน / Official Receipt").
  // Both paths persist to `invoice.receiptPdf.blobKey`. Only the filename
  // differs:
  //   - combined-mode: `{invoiceDocNum}-receipt.pdf` so the saved file
  //     does not collide with the sibling invoice PDF download
  //   - separate-mode: `{receiptDocNum}.pdf` (e.g. RC-2026-0001.pdf)
  const combinedMode = invoice.receiptDocumentNumberRaw === null;
  if (!invoice.receiptPdf) {
    // Paid + receiptPdfStatus !== 'failed' (we passed the gate above)
    // but no blob key on the row — corrupt-state path. Route layer
    // maps blob_missing to 502.
    return err({
      code: 'blob_missing',
      key: `invoicing/${input.tenantId}/${invoice.fiscalYear}/${invoice.invoiceId}_receipt_v*.pdf`,
    });
  }
  const blobKey = invoice.receiptPdf.blobKey;
  const filename = combinedMode
    ? `${invoice.documentNumber?.raw ?? 'receipt'}-receipt.pdf`
    : `${invoice.receiptDocumentNumberRaw}.pdf`;

  // Round-3 fix R3-N1 — emit audit BEFORE signing the URL. The audit
  // is the durable §87 forensic trail; if it fails (Neon transient,
  // retention column constraint) we MUST fail the read entirely
  // rather than serve a download whose access record cannot be
  // reconstructed. Reversing the order also avoids a wasted signed
  // URL whose tokenized window would tick down even though the
  // caller never receives it. Audit-before-success matches the F4
  // pattern for tx-bound mutations (Constitution Principle I clause
  // 4); read-path probes use the same ordering for consistency.
  await deps.audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId ?? null,
    eventType: 'receipt_pdf_downloaded',
    actorUserId: input.actorUserId,
    // 088 (FR-030) — a paid 088 bill has NULL §87 `documentNumber`; its SC bill
    // number lives in `billDocumentNumberRaw`. Prefer it so the download
    // cross-reference is a human-readable document number, never the raw UUID.
    summary: combinedMode
      ? `Receipt PDF downloaded — invoice ${invoice.billDocumentNumberRaw ?? invoice.documentNumber?.raw ?? invoiceId} (combined mode)`
      : `Receipt PDF downloaded — ${invoice.receiptDocumentNumberRaw} (invoice ${invoice.billDocumentNumberRaw ?? invoice.documentNumber?.raw ?? invoiceId})`,
    payload: {
      invoice_id: invoiceId,
      member_id: invoice.memberId,
      // R7-L5 — surface actor_member_id for member-actor downloads so
      // the F3 timeline filter / RD forensic SELECT can JOIN actor →
      // members without re-resolving from actor_user_id. Symmetric
      // with the cross-tenant probe emit shape. `null` for non-member
      // actors (admin/manager) so the column stays opt-in for the
      // member-timeline query.
      actor_member_id:
        input.actorRole === 'member'
          ? (input.actorMemberId ?? null)
          : null,
      receipt_document_number_raw: invoice.receiptDocumentNumberRaw,
      receipt_numbering_mode: combinedMode ? 'combined' : 'separate',
      // Round-4 fix R4-RD-H2 — surface the template version that
      // rendered the bytes. RD audit + forensic reviewers need to
      // distinguish v=1 (no logo) vs v=2 (logo-bearing) receipts when
      // reconciling a re-rendered PDF against the originally-downloaded
      // one. Pulled from the persisted snapshot on the row (not
      // CURRENT_TEMPLATE_VERSION) so historical downloads of an old
      // template stay attributable.
      receipt_pdf_template_version: invoice.receiptPdf.templateVersion,
      actor_role: input.actorRole,
      route: 'get-receipt-pdf-signed-url',
    },
  });

  // R9-E1 — wrap signDownloadUrl in try/catch parity with the CN +
  // invoice siblings. BlobNotFoundError → typed `blob_missing` Result
  // so the route handler can surface 502 + the operator-actionable
  // key instead of letting the throw fall into the route-level catch
  // and serve a generic 500 that obscures the root cause.
  let url: string;
  try {
    url = await deps.blob.signDownloadUrl(blobKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const notFound = /not found|404|BlobNotFoundError/i.test(msg);
    logger.error(
      {
        err: msg,
        invoiceId,
        tenantId: input.tenantId,
        blobKey,
        notFound,
      },
      'getReceiptPdfSignedUrl: blob sign failed',
    );
    if (notFound) return err({ code: 'blob_missing', key: blobKey });
    throw e;
  }
  return ok({ url, filename });
}
