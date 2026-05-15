'use client';

/**
 * Shared PDF download helper for admin + portal client surfaces.
 *
 * Performs the fetch+blob+toast dance so structured 4xx/5xx responses
 * surface as toasts instead of leaking the JSON error into a new tab
 * via plain `<a download>`. Replaces the admin-only helper that used
 * to live at `src/app/(staff)/admin/invoices/_lib/download-receipt-client.ts`
 * — extracted in Round 6 so the portal member surface can share the
 * same JSON-leak hardening that admin received in Rounds 1-4.
 *
 * Hardening provenance:
 *   - Round 3 (R3-BUG1) — replace plain `<a download>` with fetch+blob.
 *   - Round 3 (R3-UX2) — RFC 5987 `filename*=UTF-8''…` parser.
 *   - Round 3 (R3-UX1) — defer `URL.revokeObjectURL` 100 ms (iOS/Android race).
 *   - Round 4 (R4-SF-H-A) — log unmapped status + unexpected errors in
 *     production (no `NODE_ENV` gate). Always-on telemetry.
 *   - Round 4 (R4-SF-H-B) — log malformed RFC 5987 percent-encoding
 *     instead of silently swallowing `decodeURIComponent` throws.
 *   - Round 6 (R5-UX-M1) — optional `toastSuccess` callback for fast-
 *     cache feedback (when the loading toast dismisses before sonner's
 *     animation budget and the user otherwise sees no completion cue).
 *   - Round 6 (P1) — unified `downloadPdf` (was separate `downloadInvoice`/
 *     `downloadReceipt`). `url` is now a required input so the portal can
 *     point at `/api/portal/invoices/...` instead of `/api/invoices/...`.
 */

export type PdfDownloadToasts = {
  /** Generic forbidden (403). */
  readonly forbidden: string;
  /** Not-found (404) — invoice variant only; receipt 404 maps to forbidden. */
  readonly notFound?: string;
  /** Network / unmapped / unknown failure. */
  readonly unavailable: string;
  /** 401 — caller must re-authenticate. */
  readonly sessionExpired: string;
  /** 429 — throttled by rate-limit middleware. */
  readonly rateLimited: string;
  /**
   * 425 Too Early — async receipt-PDF render in flight. Receipt-only;
   * pass `undefined` for invoice downloads (invoice PDF is rendered
   * synchronously at issue time).
   */
  readonly pending?: string;
  /**
   * 502 with `error.code === 'receipt_pdf_failed'` — worker retry
   * budget exhausted. Receipt-only. Receives the failure reason.
   */
  readonly failed?: (reason: string) => string;
};

export type PdfDownloadDeps = {
  /** Fully-qualified URL (admin or portal scope). */
  readonly url: string;
  /** Fallback filename when Content-Disposition parsing fails. */
  readonly fallbackFilename: string;
  readonly toasts: PdfDownloadToasts;
  readonly toastWarning: (msg: string) => void;
  readonly toastError: (msg: string) => void;
  /**
   * Optional happy-path callback. Fire if no `toast.loading` was shown
   * upstream — guarantees the user sees a "Downloaded" feedback even
   * on fast-cache hits where the loading toast (if any) would dismiss
   * within sonner's animation window. R5-UX-M1.
   */
  readonly toastSuccess?: () => void;
};

/** RFC 5987-aware Content-Disposition filename parser. */
function parseContentDispositionFilename(
  header: string | null,
  fallback: string,
): string {
  if (!header) return fallback;
  const ext = /filename\*=UTF-8''([^;\r\n]+)/i.exec(header);
  if (ext?.[1]) {
    try {
      return decodeURIComponent(ext[1]);
    } catch (err) {
      // R4-SF-H-B — log instead of silently swallowing. Malformed
      // RFC 5987 encoding is a server-side header bug we want visible.
      // eslint-disable-next-line no-console
      console.warn(
        '[download-pdf] RFC 5987 filename decode failed; falling back to plain filename',
        { encoded: ext[1], err },
      );
    }
  }
  const plain = /filename="([^"]+)"|filename=([^;\s]+)/i.exec(header);
  return plain?.[1] ?? plain?.[2] ?? fallback;
}

/**
 * Download a PDF as a Blob and trigger a programmatic save dialog.
 *
 * Handles every documented 4xx/5xx response shape from the F4 PDF
 * routes (admin + portal). The caller passes locale-correct toast
 * strings; this helper only decides WHICH toast to fire.
 */
export async function downloadPdf(deps: PdfDownloadDeps): Promise<void> {
  const {
    url,
    fallbackFilename,
    toasts,
    toastWarning,
    toastError,
    toastSuccess,
  } = deps;
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      const blob = await res.blob();
      const filename = parseContentDispositionFilename(
        res.headers.get('Content-Disposition'),
        fallbackFilename,
      );
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // R3-UX1 — defer revoke so iOS Safari + Android Chrome don't
      // cancel the download from synchronous revocation.
      setTimeout(() => URL.revokeObjectURL(objectUrl), 100);
      toastSuccess?.();
      return;
    }
    if (res.status === 425 && toasts.pending) {
      toastWarning(toasts.pending);
      return;
    }
    if (res.status === 502 && toasts.failed) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; reason?: string };
      };
      if (body.error?.code === 'receipt_pdf_failed') {
        toastError(toasts.failed(body.error.reason ?? ''));
      } else {
        toastError(toasts.unavailable);
      }
      return;
    }
    if (res.status === 403) {
      toastError(toasts.forbidden);
      return;
    }
    if (res.status === 404 && toasts.notFound) {
      toastError(toasts.notFound);
      return;
    }
    if (res.status === 401) {
      toastError(toasts.sessionExpired);
      return;
    }
    if (res.status === 429) {
      toastWarning(toasts.rateLimited);
      return;
    }
    // R4-SF-H-A — always-on logging (no NODE_ENV gate).
    // eslint-disable-next-line no-console
    console.warn('[download-pdf] unmapped status', { url, status: res.status });
    toastError(toasts.unavailable);
  } catch (err) {
    // R4-SF-H-A — production telemetry binding.
    // eslint-disable-next-line no-console
    console.error('[download-pdf] unexpected client error', { url, err });
    toastError(toasts.unavailable);
  }
}
