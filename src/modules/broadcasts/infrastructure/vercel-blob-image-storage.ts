/**
 * T074 (F7.1a US2) — `ImageStoragePort` Vercel Blob adapter.
 *
 * Pattern follows F4 `vercel-blob-adapter.ts` (BLOB_READ_WRITE_TOKEN
 * from env). Tenant-scoped key namespace prevents cross-tenant URL
 * collision and lets `existsByContentHash` issue a tight `head()`
 * probe per known MIME.
 *
 * Public access — same rationale as F4 invoice-logo public assets:
 * Resend mail-client UAs do NOT support Bearer / signed-URL fetches;
 * the inline image URL embedded in the broadcast body MUST be
 * unauthenticated GET. Content-hash makes URLs unguessable enough to
 * deter casual scraping (collisions require a SHA-256 preimage of
 * arbitrary tenant content).
 */
import {
  BlobAccessError,
  BlobClientTokenExpiredError,
  BlobNotFoundError,
  BlobServiceNotAvailable,
  BlobServiceRateLimited,
  BlobStoreSuspendedError,
  put,
  head,
  del,
} from '@vercel/blob';
import { logger } from '@/lib/logger';
import {
  ImageStorageUnavailableError,
  type ImageMimeType,
  type ImageProbeResult,
  type ImageStoragePort,
  type StoredImageRef,
} from '../application/ports/image-storage-port';
import type { TenantSlug } from '@/modules/tenants';
import { env } from '@/lib/env';

/**
 * NOT-FOUND is classified by the SDK's own class. `@vercel/blob@2.3.3`
 * exports `BlobNotFoundError` and its message is "Vercel Blob: The requested
 * blob does not exist" — the earlier regex (`not found|404`) never matched
 * it, so every genuine miss read as `unknown` and the `absent` arm below was
 * dead in production (round-3 reliability re-check, 2026-09-22). Pinned by
 * `tests/unit/broadcasts/infrastructure/vercel-blob-image-storage-probe.test.ts`
 * against the real class, never a hand-written string. Auth / suspend /
 * rate-limit errors still surface to the logger (SF-H1).
 */

/**
 * F119 F7-2 — a storage OUTAGE is likewise classified by the SDK's own
 * classes, here and only here, and handed to the use case as the port's
 * `ImageStorageUnavailableError` (503, retry). The use case used to regex
 * `e.message` for these CLASS names, which the real messages never contain
 * ("Vercel Blob: This store has been suspended."), so a real outage 500'd.
 *
 * Deliberately the five subclasses, never their base `BlobError`: the
 * already-exists refusal of `allowOverwrite: false` is a PLAIN `BlobError`
 * (2.3.3 has no subclass for it) and must reach `isBlobAlreadyExists`
 * unchanged. Pinned against the real classes by
 * `tests/unit/broadcasts/infrastructure/vercel-blob-image-storage-put.test.ts`.
 */
function isStorageOutage(e: unknown): e is Error {
  return (
    e instanceof BlobAccessError ||
    e instanceof BlobStoreSuspendedError ||
    e instanceof BlobClientTokenExpiredError ||
    e instanceof BlobServiceRateLimited ||
    e instanceof BlobServiceNotAvailable
  );
}

const MIME_EXT: Record<ImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function buildKey(
  tenantId: TenantSlug,
  contentHash: string,
  mime: ImageMimeType,
): string {
  const ext = MIME_EXT[mime];
  return `broadcasts/images/${tenantId}/${contentHash}.${ext}`;
}

export const vercelBlobImageStorage: ImageStoragePort = {
  async existsByContentHash(
    tenantId: TenantSlug,
    contentHash: string,
    mimeType: ImageMimeType,
  ): Promise<ImageProbeResult> {
    // PR-review fix 2026-05-20 CR-M3 — probe ONE key (caller knows
    // MIME) instead of the previous 4-MIME fan-out. The cross-MIME
    // dedup guarantee was meaningless because SHA-256 over format-
    // header-bearing bytes cannot collide across formats.
    const key = buildKey(tenantId, contentHash, mimeType);
    try {
      const meta = await head(key, {
        token: env.blob.readWriteToken,
      });
      return { status: 'present', blobUrl: meta.url, blobKey: key };
    } catch (e) {
      // PR-review fix SF-H1 — narrow swallow to NOT-FOUND only.
      // Other error classes (BlobAccessError / BlobClientTokenExpired /
      // BlobStoreSuspended / BlobServiceRateLimited) silently looked
      // like cache-miss + masked ops incidents.
      //
      // ROUND-3 #1 — they now also answer differently. SF-H1 logged them but
      // still returned the same `null` a 404 returns, and the caller cannot
      // tell those apart from the value: under the upload's content-hash lock
      // a rate-limited `head` looked exactly like "the sweep took the bytes".
      // A failed probe is `unknown`; only a genuine 404 is `absent`.
      const msg = e instanceof Error ? e.message : String(e);
      if (e instanceof BlobNotFoundError) return { status: 'absent' };
      logger.warn(
        { err: msg, tenantId, contentHash, mime: mimeType },
        'broadcasts.blob_head_error',
      );
      return { status: 'unknown', reason: msg };
    }
  },

  async put(input: {
    readonly tenantId: TenantSlug;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly mimeType: ImageMimeType;
    readonly sanitisedFilename: string;
  }): Promise<StoredImageRef & { readonly contentHash: string }> {
    const key = buildKey(input.tenantId, input.contentHash, input.mimeType);
    const result = await put(key, Buffer.from(input.bytes), {
      access: 'public',
      contentType: input.mimeType,
      token: env.blob.readWriteToken,
      // Content-hash key + addRandomSuffix:false means the key names the
      // bytes: whatever sits at it is the content we would be writing.
      //
      // ROUND-3 #1 — the note that used to stand here said re-uploading the
      // SAME content was "idempotent (Blob returns the existing URL)". It is
      // not: with `allowOverwrite: false` @vercel/blob THROWS when the
      // pathname is taken, whatever the bytes are. That is still the right
      // setting (see L-3 below), but it makes a PUT over existing content an
      // ERROR the caller has to absorb, not a no-op — `uploadInlineImage`'s
      // re-PUT under the content-hash lock treats that refusal as "stored".
      //
      // LOW review note 2026-05-21 (code-reviewer-full
      // L-3): allowOverwrite=false additionally rejects any attempt to
      // overwrite a different-content entry at the same key — defence
      // in depth against sha256-preimage collisions (infeasible) AND
      // against a Vercel Blob content-type-confusion bug. Recovery
      // from a poisoned-cache scenario would require manual ops:
      // (a) `vercel blob delete <key>` via Vercel CLI, (b) re-upload
      // legitimate content. M1 Round 2 closure 2026-05-21 (comment-
      // analyzer H-3): no dedicated runbook authored — the procedure
      // above IS the recovery; create a `docs/runbooks/blob-poisoned-
      // cache.md` only if the incident ever occurs (zero hits to date).
      addRandomSuffix: false,
      allowOverwrite: false,
    }).catch((e: unknown) => {
      // F7-2 — an outage becomes the port error; everything else (the
      // already-exists `BlobError` included) propagates unchanged.
      if (isStorageOutage(e)) {
        throw new ImageStorageUnavailableError(e.message, { cause: e });
      }
      throw e;
    });
    return { blobUrl: result.url, blobKey: key, contentHash: input.contentHash };
  },

  // F119 T034 — the sweep's delete. `del` is idempotent on a missing key at
  // the Blob API (no throw), so a blob already gone counts as deleted; any
  // other failure propagates and the sweep retries the row next tick.
  async delete(blobKey: string): Promise<void> {
    await del(blobKey, { token: env.blob.readWriteToken });
  },
};
