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
 * short-circuit re-uploads of identical bytes. Its answer is TRI-STATE
 * (ROUND-3 #1) — `present` / `absent` / `unknown` — because "I looked and
 * there is nothing there" and "I could not look" lead to opposite actions,
 * and collapsing them onto one `null` made the upload act on a probe that
 * knew nothing. Only `present` is a guarantee; `absent` is still allowed to
 * be cache-cold, so the use case MUST NOT depend on it for correctness.
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
   * Probe the tenant-scoped, content-addressed key for `contentHash`.
   *
   * `present` is a strict guarantee that the bytes are reachable and carries
   * the URL + key. `absent` means the probe RAN and the object is not there —
   * still not a strict guarantee (a cold cache may answer 404 for an object
   * that exists), so a caller acting on it must tolerate the object being
   * back by the time it writes. `unknown` means the probe FAILED (rate-limit,
   * expired token, service outage): nothing at all is known, and a caller
   * MUST NOT treat it as either of the other two.
   *
   * PR-review fix 2026-05-20 CR-M3 — caller passes `mimeType` so the
   * adapter probes ONE key (vs all 4 MIME extensions, 160-320ms p95
   * waste). The caller already knows MIME at the cap-check boundary.
   */
  existsByContentHash(
    tenantId: TenantSlug,
    contentHash: string,
    mimeType: ImageMimeType,
  ): Promise<ImageProbeResult>;

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
  }): Promise<StoredImageRef & { readonly contentHash: string }>;

  /**
   * F119 T034 — delete the object at `blobKey`. Before F119 the port had no
   * delete method at all, so inline-image blobs were never reclaimed. The
   * ONLY caller is the daily sweep (`reclaimOrphanedImages`), which deletes
   * a blob iff no live `broadcast_images` row of either owner_kind shares
   * its content hash (the last-reference rule). Throws on a transient
   * failure so the sweep keeps the row and retries next tick.
   */
  delete(blobKey: string): Promise<void>;
}

/**
 * F119 F7-2 — the storage backend refused for one of exactly FIVE known
 * outage reasons: access denied, client token expired, store suspended,
 * rate-limited, service unavailable (`@vercel/blob@2.3.3` `BlobAccessError`,
 * `BlobClientTokenExpiredError`, `BlobStoreSuspendedError`,
 * `BlobServiceRateLimited`, `BlobServiceNotAvailable`). The adapter
 * classifies those classes by `instanceof` and rethrows this, with the SDK
 * error as `cause`, so the use case can answer `storage_unavailable` (503,
 * retry) without importing the SDK.
 *
 * It is NOT "every way the backend can be down". `BlobUnknownError` (what the
 * SDK throws after its own retries of an `internal_server_error` /
 * `unknown_error`) deliberately stays out and surfaces as a 500 (F7-6): an
 * error nobody has classified may be a real bug, and a 500 is the honest
 * answer to it.
 *
 * It replaces a regex over `e.message` for the SDK CLASS names — which the
 * real `@vercel/blob@2.3.3` errors never carry (their messages read
 * "Vercel Blob: This store has been suspended." and so on), so every real
 * outage fell through to a 500.
 */
export class ImageStorageUnavailableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ImageStorageUnavailableError';
  }
}

/**
 * F119 — the stable public URL AND the storage key of one stored image.
 * The key is what `broadcast_images.blob_key` records and what `delete`
 * takes; the URL is what the HTML carries.
 */
export interface StoredImageRef {
  readonly blobUrl: string;
  readonly blobKey: string;
}

/**
 * ROUND-3 #1 — the answer to "are these bytes stored?", with "I could not
 * find out" kept DISTINCT from "no".
 *
 * The adapter used to return `null` for a 404 and for every other `head`
 * failure alike. Under the upload's content-hash lock that `null` was read as
 * "the sweep reclaimed the blob", so a transient Blob rate-limit made the
 * upload re-PUT bytes that were still there — into a store whose
 * `allowOverwrite: false` makes that PUT throw, rolling back the row the
 * member had just earned and stranding the blob with nothing pointing at it.
 */
export type ImageProbeResult =
  | ({ readonly status: 'present' } & StoredImageRef)
  | { readonly status: 'absent' }
  | { readonly status: 'unknown'; readonly reason: string };
