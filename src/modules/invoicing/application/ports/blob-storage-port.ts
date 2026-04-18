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
  }): Promise<{ readonly key: string; readonly url: string }>;

  /**
   * Issue a short-lived (60s) signed URL for a private key.
   */
  signDownloadUrl(key: string, ttlSeconds?: number): Promise<string>;

  /** Delete a key (used by transactional sweeper). */
  delete(key: string): Promise<void>;
}
