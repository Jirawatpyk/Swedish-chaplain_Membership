/**
 * T126 — `renderAndUploadPdf` — compress the 4 duplicated
 * `try { pdfRender.render } catch → pdf_render_failed` +
 * `try { blob.uploadPdf } catch → blob_upload_failed` pairs across
 * the F4 mutating use cases:
 *
 *   1. `issueInvoice` (G step)                      — invoice PDF
 *   2. `recordPayment` (H step)                     — receipt PDF
 *   3. `issueCreditNote` (G step)                   — credit-note PDF
 *   4. `issueCreditNote` (J2 re-annotation step)    — annotated invoice PDF
 *
 * Each use-case defines its own `InternalError` class with a union of
 * error codes that includes `pdf_render_failed` + `blob_upload_failed`.
 * The `wrap` callback lets the helper stay generic over the concrete
 * error type — the caller turns a `(kind, reason)` pair into its own
 * typed throwable.
 *
 * Why rethrow instead of returning a Result:
 *   All 4 call sites live INSIDE `withTx` callbacks. Returning a
 *   `Result` here would force callers to manually re-throw to trigger
 *   tx rollback — the helper just does that directly, matching the
 *   existing inline pattern.
 *
 * Preserves the A-M letter flow at each call site — the helper is
 * substituted 1:1 for two adjacent try/catch blocks, so code reviewers
 * can map call-site letters (G/H/J2) to the same functional boundary.
 *
 * The `reason` is a closed code, `<step>:<ErrClass>[:<code>]` (`render:TypeError`,
 * `upload:TypeError:ECONNRESET`,
 * `upload:BlobError`; `annotation_render:Error` with the J2 re-annotation
 * `reasonPrefix`), never the thrown text (#739): it is stored in
 * `invoices.receipt_pdf_last_error` and `notifications_outbox.last_error`
 * and audited, and a drizzle error's message quotes bound parameters. The
 * failure's class, SQLSTATE and code go to one WARN line here instead.
 */
import { errLogFields } from '@/lib/log-id';
import { logger } from '@/lib/logger';

import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { PdfRenderInput, PdfRenderPort, PdfRenderResult } from '../ports/pdf-render-port';

export interface RenderAndUploadDeps {
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
}

export type RenderAndUploadFailureKind =
  | 'pdf_render_failed'
  | 'blob_upload_failed';

export interface RenderAndUploadInput {
  readonly renderInput: PdfRenderInput;
  readonly blobKey: string;
  /**
   * Whether the Blob adapter should overwrite an existing object at
   * `blobKey`. Only the J2 re-annotation path sets this true — the
   * annotated PDF bytes MUST overwrite the original (different sha256
   * by design per the "VOID overlay" overlay story in data-model.md).
   */
  readonly allowOverwrite?: boolean;
  /**
   * Optional prefix for the `reason` string passed to `wrap`. Used by
   * the J2 re-annotation path to tag failures as `annotation_<step>:…`
   * so operators can distinguish them from the initial-issue path.
   */
  readonly reasonPrefix?: string;
}

/**
 * Render a PDF + upload to Blob. Rethrows via `wrap(kind, reason)`
 * on either step's failure so the enclosing `withTx` rolls back.
 *
 * Returns the `PdfRenderResult` on success so callers can pass
 * `rendered.sha256` to the mutation step (e.g., the invoices /
 * credit_notes INSERT).
 */
export async function renderAndUploadPdf(
  deps: RenderAndUploadDeps,
  input: RenderAndUploadInput,
  wrap: (kind: RenderAndUploadFailureKind, reason: string) => Error,
): Promise<PdfRenderResult & { readonly etag?: string }> {
  const reasonFor = (step: 'render' | 'upload', e: unknown): string => {
    const fields = errLogFields(e);
    // The blob key names the tenant, fiscal year and invoice (no PII), so
    // the line joins back to the row whose column holds the code.
    logger.warn(
      { step: input.reasonPrefix ? `${input.reasonPrefix}_${step}` : step, blobKey: input.blobKey, ...fields },
      'invoicing.pdf.render_and_upload_failed',
    );
    // A token-shaped SQLSTATE or errno rides on the code, so the 10-year
    // audit row keeps the cause after the log is gone.
    const code = fields.code ?? fields.errCode;
    return `${input.reasonPrefix ? `${input.reasonPrefix}_` : ''}${step}:${fields.err}${code !== undefined ? `:${code}` : ''}`;
  };

  let rendered: PdfRenderResult;
  try {
    rendered = await deps.pdfRender.render(input.renderInput);
  } catch (e) {
    throw wrap('pdf_render_failed', reasonFor('render', e));
  }

  let uploaded: { readonly etag?: string } | undefined;
  try {
    uploaded = await deps.blob.uploadPdf({
      key: input.blobKey,
      body: rendered.bytes,
      contentType: 'application/pdf',
      ...(input.allowOverwrite ? { allowOverwrite: true as const } : {}),
    });
  } catch (e) {
    throw wrap('blob_upload_failed', reasonFor('upload', e));
  }

  // #60 — the stored etag lets a catch-path cleanup delete conditionally.
  const etag = uploaded?.etag;
  return etag !== undefined ? { ...rendered, etag } : rendered;
}
