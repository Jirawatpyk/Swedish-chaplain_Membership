/**
 * F9 US5/US6 `PrivateBlobPort` Application port (T069 / research R6).
 *
 * Private Vercel Blob delivery for PII-bearing export artefacts (Directory
 * E-Book, GDPR archive). Unlike the F4 invoice-logo store (`access:'public'`),
 * these objects are stored `access:'private'` and streamed ONLY through the
 * authenticated download proxy — the Blob URL is never exposed to the client.
 *
 * Pure interface — no `@vercel/blob` import (Constitution Principle III); the
 * Infrastructure adapter binds it.
 */

export interface PrivateBlobObject {
  /** Streamed bytes of the private object. */
  readonly stream: ReadableStream<Uint8Array>;
  readonly contentType: string | null;
}

export interface PrivateBlobPort {
  /**
   * Upload bytes to a private Blob object at a deterministic key. Overwrites an
   * existing object at the same key (worker reclaim re-runs produce a fresh
   * artefact for the same job).
   */
  putPrivate(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly key: string }>;

  /** Stream a private object server-side. Returns null if the object is absent. */
  download(key: string): Promise<PrivateBlobObject | null>;

  /** Delete a private object (TTL sweep). Idempotent. */
  delete(key: string): Promise<void>;
}
