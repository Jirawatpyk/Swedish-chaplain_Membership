/**
 * T032 — Blob storage port (F4).
 * Backed by Vercel Blob (private). Deterministic content-addressed keys.
 */
export interface BlobStoragePort {
  /**
   * Upload a PDF buffer. Returns the stable Blob URL / key.
   * The adapter computes the key from the input (tenantId + doc_type
   * + doc_id + sha256) so idempotent replay produces the same key.
   */
  uploadPdf(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: 'application/pdf';
    /**
     * Review fix CR-1 (2026-04-20) — allow overwriting an existing
     * object at the same key with DIFFERENT bytes. Default `false`
     * preserves the historical tax-document integrity guarantee for
     * issue-time uploads (PDF rendering is deterministic → same bytes
     * re-produced → conflict is safely treated as success).
     *
     * Must be `true` for the US6 AS4 rollup + FR-008 VOID re-stamp
     * paths where the re-render DOES produce different bytes (adds a
     * status overlay to the invoice PDF). Without it the overwrite
     * silently no-ops, DB `pdf_sha256` drifts from the Blob content,
     * and FR-016 integrity breaks.
     */
    readonly allowOverwrite?: boolean;
  }): Promise<{ readonly key: string; readonly url: string }>;

  /**
   * R7-B2 — upload a tenant logo image. Distinct from uploadPdf so
   * the content-type narrowing on uploadPdf stays strict. Keys are
   * callers' responsibility (logos use `invoicing/{tenant}/logos/…`
   * format; see `uploadTenantLogo` use-case).
   */
  uploadLogo(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: 'image/png' | 'image/jpeg';
  }): Promise<{ readonly key: string; readonly url: string }>;

  /**
   * Return the stable download URL for a stored key. The Chamber-OS
   * architecture proxies every user-facing download through an
   * authenticated route (`/api/invoices/[id]/pdf`, `/api/credit-notes/[id]/pdf`)
   * — the Blob URL itself is never exposed to the client — so a per-
   * request TTL is not required here. If a future caller needs a
   * short-lived URL independent of the proxy (e.g. a direct external
   * share), add a dedicated `signDownloadUrlWithTtl` method rather
   * than re-adding an ignored parameter to this signature.
   */
  signDownloadUrl(key: string): Promise<string>;

  /**
   * FR-036 email-attachment path — read the stored bytes of a private
   * key. Used by the outbox dispatcher to attach the VOID-stamped
   * invoice PDF to the cancellation email (a download link is not
   * sufficient per spec: the bookkeeper needs a filing-complete
   * attachment matching the original invoice they already filed).
   *
   * Throws on missing key / network failure — the caller (dispatcher)
   * treats the throw as a transient failure and retries per the
   * outbox retry ladder.
   */
  downloadBytes(key: string): Promise<Uint8Array>;

  /** Delete a key (used by transactional sweeper). */
  delete(key: string): Promise<void>;

  /**
   * T092b — list keys under a prefix. Used by the logo-upload use case
   * to enforce the 50-logo-per-tenant history cap (FR-034 + R2-E6).
   * Returns keys only (URLs not needed for the count gate).
   *
   * `limit` is REQUIRED so callers explicitly name their page bound —
   * prevents silent truncation surprises (F-06). For count-gate callers
   * (cap ≤ N), pass `N + headroom` and assert `result.length >= N`.
   * Implementations MUST cap at `limit` and MUST NOT paginate — if a
   * caller needs the full namespace they should add a dedicated paged
   * method. Currently no such need.
   */
  list(prefix: string, limit: number): Promise<readonly string[]>;
}
