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

const IMAGE_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/**
 * PR-review fix 2026-05-20 TD-M3 — user-defined type guard so the
 * use-case narrows `string → ImageMimeType` without an `as` cast.
 * Replaces `ALLOWED_MIME.has(input.mimeType as ImageMimeType)` which
 * lied to the type system (Set.has accepts string regardless).
 */
export function isImageMimeType(s: string): s is ImageMimeType {
  return IMAGE_MIME_TYPES.has(s);
}

export interface ImageStoragePort {
  /**
   * Return the existing blob URL for `contentHash` in the tenant's
   * scope, or `null` when not present (or cache-cold). Adapter is
   * free to perform a `HEAD`-style probe; absence is not a strict
   * guarantee that the bytes are gone, but presence is a strict
   * guarantee that they are still reachable.
   *
   * PR-review fix 2026-05-20 CR-M3 — caller passes `mimeType` so the
   * adapter probes ONE key (vs all 4 MIME extensions, 160-320ms p95
   * waste). The caller already knows MIME at the cap-check boundary.
   */
  existsByContentHash(
    tenantId: TenantSlug,
    contentHash: string,
    mimeType: ImageMimeType,
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
