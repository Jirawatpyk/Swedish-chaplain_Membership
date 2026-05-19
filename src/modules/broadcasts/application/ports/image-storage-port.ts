/**
 * T071 supporting port — `ImageStoragePort` Application port (F7.1a US2).
 *
 * Abstracts inline-image persistence so the `uploadInlineImage`
 * Application use-case stays free of `@vercel/blob` and tenant-path
 * formatting concerns. The Vercel Blob adapter (T074
 * `vercel-blob-image-storage.ts`) is the production implementation;
 * tests inject in-memory fakes.
 *
 * Content-addressed dedup: callers MAY call `existsByContentHash` to
 * short-circuit re-uploads of identical bytes. The adapter is free to
 * return `null` even when a row exists (cache-cold), so the use case
 * MUST NOT depend on it for correctness — only performance.
 *
 * Pure interface — no framework imports (Constitution Principle III
 * NON-NEGOTIABLE).
 */
import type { TenantSlug } from '@/modules/tenants';

export type ImageMimeType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'image/gif';

export interface ImageStoragePort {
  /**
   * Return the existing blob URL for `contentHash` in the tenant's
   * scope, or `null` when not present (or cache-cold). Adapter is
   * free to perform a `HEAD`-style probe; absence is not a strict
   * guarantee that the bytes are gone, but presence is a strict
   * guarantee that they are still reachable.
   */
  existsByContentHash(
    tenantId: TenantSlug,
    contentHash: string,
  ): Promise<string | null>;

  /**
   * Upload bytes into the tenant-scoped namespace. Returns a stable
   * Blob URL + the content-hash actually persisted (the use case may
   * compare to its pre-computed hash for defence-in-depth).
   */
  put(input: {
    readonly tenantId: TenantSlug;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly mimeType: ImageMimeType;
    readonly sanitisedFilename: string;
  }): Promise<{ readonly blobUrl: string; readonly contentHash: string }>;
}
