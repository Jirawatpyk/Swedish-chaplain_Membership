import { NextResponse } from 'next/server';
import { buildAttachmentContentDisposition } from '@/lib/content-disposition';
import { logger } from '@/lib/logger';

/**
 * Shared server-to-Blob byte-streaming helper for all PDF download routes.
 *
 * Historically every PDF route (invoice + receipt + credit-note ×
 * admin + portal = 6 routes) duplicated the same ~35-line block:
 *   - `fetch(url)` of the Vercel Blob public URL
 *   - try/catch around the fetch (network throw → 502)
 *   - `!response.ok || !response.body` check (upstream non-200 → 502)
 *   - RFC 6266 Content-Disposition header assembly via
 *     `buildAttachmentContentDisposition`
 *   - `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`
 *   - `NextResponse(body, { headers })`
 *
 * Extracting these into one helper:
 *   1. Removes ~180 lines of duplication across 6 routes (R10-S1).
 *   2. Adds `AbortSignal.timeout(15_000)` so a slow / unreachable
 *      Vercel Blob CDN surfaces as a clean 502 + structured pino log
 *      within 15s, instead of holding the connection for the full
 *      Vercel function timeout (~300s) — closes R10-E1.
 *   3. Makes the F5 Stripe receipt-download route's PDF stream stage
 *      a 1-line call rather than a 7th paste.
 *
 * The signed Blob URL never leaves the server (R7-B1) — bytes are
 * proxied through this route handler so client capture cannot grant
 * permanent untokenised access.
 */
export interface StreamPdfFromBlobInput {
  /** Vercel Blob public URL returned by `BlobStoragePort.signDownloadUrl`. */
  readonly url: string;
  /** Filename to surface in the `Content-Disposition` header. */
  readonly filename: string;
  /**
   * Pino log context — the helper logs `error` for fetch throws +
   * upstream non-OK responses + AbortSignal timeouts. Include enough
   * fields for operator triage (request id, tenant, resource id, route).
   */
  readonly logContext: Record<string, unknown>;
  /**
   * Route tag used in the log message + error payload to disambiguate
   * which surface failed when multiple PDF routes share the same
   * operator dashboard. Examples: `admin-invoice-pdf`,
   * `portal-receipt-pdf`, `admin-credit-note-pdf`.
   */
  readonly route: string;
  /**
   * Override the 15s upstream-fetch timeout. The default is calibrated
   * for the typical 50–500 KB invoice PDF round-tripping from
   * Singapore Vercel Blob to Singapore Vercel function. Raise for
   * large credit-note batches; lower for low-latency-sensitive
   * surfaces.
   */
  readonly timeoutMs?: number;
}

/**
 * Returns a `200 NextResponse` streaming the PDF bytes on success, or
 * a `502 { error: { code: 'blob_fetch_failed' | 'blob_fetch_timeout' } }`
 * on network / upstream / timeout failure. The caller is responsible
 * for emitting all preceding error paths (404 / 403 / 425 / etc.) —
 * this helper handles ONLY the byte-streaming stage that begins after
 * a successful `signDownloadUrl` Result.
 */
export async function streamPdfFromBlob(
  input: StreamPdfFromBlobInput,
): Promise<NextResponse> {
  const { url, filename, logContext, route, timeoutMs = 15_000 } = input;

  let blobResponse: Response;
  try {
    blobResponse = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // `AbortSignal.timeout` rejects with `name === 'TimeoutError'`;
    // distinguish from generic network errors so operators can split
    // alert thresholds (timeout = capacity issue; failed = SDK/DNS).
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    const errorCode = isTimeout ? 'blob_fetch_timeout' : 'blob_fetch_failed';
    logger.error(
      { ...logContext, errorCode, timeoutMs: isTimeout ? timeoutMs : undefined, err },
      `GET ${route} — blob fetch ${isTimeout ? 'timed out' : 'failed'}`,
    );
    return NextResponse.json(
      { error: { code: errorCode } },
      { status: 502 },
    );
  }
  if (!blobResponse.ok || !blobResponse.body) {
    logger.error(
      { ...logContext, blobStatus: blobResponse.status },
      `GET ${route} — blob upstream non-OK`,
    );
    return NextResponse.json(
      { error: { code: 'blob_fetch_failed' } },
      { status: 502 },
    );
  }

  // RFC 6266-compliant Content-Disposition (T121 — CR/LF + quote +
  // non-ASCII sanitisation applied centrally). Pass the logger so any
  // filename strip (CR/LF injection probe / oversized) surfaces in
  // ops dashboards with the route tag — previously only the portal
  // credit-note route opted into this logging, now every PDF route
  // inherits it for free.
  const contentDisposition = buildAttachmentContentDisposition(filename, {
    logger,
    context: route,
  });
  const contentLength = blobResponse.headers.get('content-length');

  const headers: Record<string, string> = {
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDisposition,
    'Cache-Control': 'no-store',
    // Signal to middleboxes that the response is opaque to content
    // sniffing — browsers must not reinterpret the bytes.
    'X-Content-Type-Options': 'nosniff',
  };
  if (contentLength) headers['Content-Length'] = contentLength;

  return new NextResponse(blobResponse.body, { status: 200, headers });
}
