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
   * Issue a short-lived (60s) signed URL for a private key.
   */
  signDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;

  /** Delete a key (used by transactional sweeper). */
  delete(key: string): Promise<void>;
}
