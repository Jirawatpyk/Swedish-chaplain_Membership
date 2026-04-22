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
 * The `reasonPrefix` option supports the J2 re-annotation path's
 * `"annotation render: ..."` / `"annotation upload: ..."` messages
 * so the post-rollback log distinguishes the initial-issue failure
 * from the credit-note-triggered re-annotation failure on the same
 * invoice.
 */
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
   * the J2 re-annotation path to tag failures as `"annotation ..."`
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
): Promise<PdfRenderResult> {
  let rendered: PdfRenderResult;
  try {
    rendered = await deps.pdfRender.render(input.renderInput);
  } catch (e) {
    const reason = input.reasonPrefix
      ? `${input.reasonPrefix} render: ${String(e)}`
      : String(e);
    throw wrap('pdf_render_failed', reason);
  }

  try {
    await deps.blob.uploadPdf({
      key: input.blobKey,
      body: rendered.bytes,
      contentType: 'application/pdf',
      ...(input.allowOverwrite ? { allowOverwrite: true as const } : {}),
    });
  } catch (e) {
    const reason = input.reasonPrefix
      ? `${input.reasonPrefix} upload: ${String(e)}`
      : String(e);
    throw wrap('blob_upload_failed', reason);
  }

  return rendered;
}
