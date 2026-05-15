'use client';

/**
 * Shared receipt-PDF download helper for client surfaces (menu +
 * list-table action cell). Performs the fetch+blob+toast dance so a
 * 425 Too Early / 502 receipt_pdf_failed / 401 / 429 surfaces as a
 * structured toast instead of leaking the JSON error into a new tab
 * via plain `<a download>`.
 *
 * Round-3 fix R3-BUG1 — the list-table Receipt link previously used
 * a plain anchor, regressing the H-5 fix that was applied only to
 * the detail-page menu. Both surfaces now share this helper.
 *
 * Round-3 fix R3-UX2 — RFC 5987 `filename*=UTF-8''…` is parsed
 * before falling back to plain `filename=`. Thai receipt names
 * (which `buildAttachmentContentDisposition` emits as RFC 5987
 * extended form) now download with their correct filename.
 *
 * Round-3 fix R3-UX1 — `URL.revokeObjectURL` is deferred via
 * `setTimeout(..., 100)` to avoid the iOS Safari + Android Chrome
 * race where revoking synchronously cancels the download.
 */

export type ReceiptDownloadToasts = {
  readonly pending: string;
  readonly failed: (reason: string) => string;
  readonly forbidden: string;
  readonly unavailable: string;
  readonly sessionExpired: string;
  readonly rateLimited: string;
};

export type ReceiptDownloadDeps = {
  readonly invoiceId: string;
  /** Fallback filename when Content-Disposition parsing fails. */
  readonly fallbackFilename: string;
  readonly toasts: ReceiptDownloadToasts;
  readonly toastWarning: (msg: string) => void;
  readonly toastError: (msg: string) => void;
};

/**
 * Toast bundle for invoice-PDF download. Smaller surface than the
 * receipt variant because invoice PDF has no async-pending state
 * (it's rendered synchronously at issue time) so no 425.
 */
export type InvoiceDownloadToasts = {
  readonly forbidden: string;
  readonly notFound: string;
  readonly unavailable: string;
  readonly sessionExpired: string;
  readonly rateLimited: string;
};

export type InvoiceDownloadDeps = {
  readonly invoiceId: string;
  readonly fallbackFilename: string;
  readonly toasts: InvoiceDownloadToasts;
  readonly toastWarning: (msg: string) => void;
  readonly toastError: (msg: string) => void;
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
      // Round-4 fix R4-SF-H-B — malformed RFC 5987 percent-encoding
      // is rare but real (e.g. a stray `%` in the filename header).
      // Previously we swallowed the throw silently and fell through
      // to plain-filename parsing, hiding the parser bug from
      // observability. Always-log so server-side header bugs
      // surface in browser DevTools / client error trackers.
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
 * Invoice-PDF download (admin context). Same fetch+blob pattern as
 * the receipt variant but without the 425/502-failed handling
 * (invoice render is synchronous at issue time — there is no
 * async pending state).
 *
 * Round-3 follow-up — added for parity with `downloadReceipt` so
 * both Actions surfaces (table + menu) handle 401/403/404/429/5xx
 * with structured toasts instead of leaking JSON-in-a-new-tab.
 */
export async function downloadInvoice(deps: InvoiceDownloadDeps): Promise<void> {
  const { invoiceId, fallbackFilename, toasts, toastWarning, toastError } = deps;
  try {
    const res = await fetch(`/api/invoices/${invoiceId}/pdf`);
    if (res.status === 200) {
      const blob = await res.blob();
      const filename = parseContentDispositionFilename(
        res.headers.get('Content-Disposition'),
        fallbackFilename,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
      return;
    }
    if (res.status === 403) {
      toastError(toasts.forbidden);
      return;
    }
    if (res.status === 404) {
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
    // Round-4 fix R4-SF-H-A — log in production too, not just dev.
    // The previous `NODE_ENV !== 'production'` gate created a
    // telemetry blackhole: every unmapped-status path was silenced
    // for the actual users we care about. Browser-side console.warn
    // is captured by any frontend error monitor (Sentry/Datadog RUM/
    // LogRocket) and at minimum lands in DevTools when the support
    // team asks the user to share a screen.
    // eslint-disable-next-line no-console
    console.warn('[download-invoice] unmapped status', res.status);
    toastError(toasts.unavailable);
  } catch (err) {
    // Round-4 fix R4-SF-H-A — always log, including production.
    // eslint-disable-next-line no-console
    console.error('[download-invoice] unexpected client error', err);
    toastError(toasts.unavailable);
  }
}

export async function downloadReceipt(deps: ReceiptDownloadDeps): Promise<void> {
  const { invoiceId, fallbackFilename, toasts, toastWarning, toastError } = deps;
  try {
    const res = await fetch(`/api/invoices/${invoiceId}/receipt/pdf`);
    if (res.status === 200) {
      const blob = await res.blob();
      const filename = parseContentDispositionFilename(
        res.headers.get('Content-Disposition'),
        fallbackFilename,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 100);
      return;
    }
    if (res.status === 425) {
      toastWarning(toasts.pending);
      return;
    }
    if (res.status === 502) {
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
    if (res.status === 401) {
      toastError(toasts.sessionExpired);
      return;
    }
    if (res.status === 429) {
      toastWarning(toasts.rateLimited);
      return;
    }
    // Round-4 fix R4-SF-H-A — log in production too. See downloadInvoice for rationale.
    // eslint-disable-next-line no-console
    console.warn('[download-receipt] unmapped status', res.status);
    toastError(toasts.unavailable);
  } catch (err) {
    // Round-4 fix R4-SF-H-A — always log, including production.
    // eslint-disable-next-line no-console
    console.error('[download-receipt] unexpected client error', err);
    toastError(toasts.unavailable);
  }
}
