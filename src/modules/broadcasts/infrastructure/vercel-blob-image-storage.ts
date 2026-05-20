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
import { put, head } from '@vercel/blob';
import { logger } from '@/lib/logger';
import type {
  ImageMimeType,
  ImageStoragePort,
} from '../application/ports/image-storage-port';
import type { TenantSlug } from '@/modules/tenants';
import { env } from '@/lib/env';

/**
 * @vercel/blob does not export typed error classes — F4 detects
 * NOT-FOUND via message regex (see get-credit-note-pdf-signed-url.ts:103).
 * Mirror that pattern here so dedup probes only swallow genuine
 * not-founds; auth / suspend / rate-limit errors surface to logger
 * for ops visibility (PR-review fix 2026-05-20 SF-H1 closure).
 */
const BLOB_NOT_FOUND_PATTERN = /not found|404|BlobNotFoundError/i;

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
  ): Promise<string | null> {
    for (const mime of Object.keys(MIME_EXT) as ImageMimeType[]) {
      try {
        const meta = await head(buildKey(tenantId, contentHash, mime), {
          token: env.blob.readWriteToken,
        });
        return meta.url;
      } catch (e) {
        // PR-review fix SF-H1 — narrow swallow to NOT-FOUND only.
        // Other error classes (BlobAccessError / BlobClientTokenExpired /
        // BlobStoreSuspended / BlobServiceRateLimited) silently
        // looked like cache-miss + masked ops incidents. Now they
        // log at warn level + abort the probe (caller proceeds to
        // fresh `put` which will surface the same error class
        // explicitly via PUT path).
        const msg = e instanceof Error ? e.message : String(e);
        if (BLOB_NOT_FOUND_PATTERN.test(msg)) continue;
        logger.warn(
          { err: msg, tenantId, contentHash, mime },
          'broadcasts.blob_head_error',
        );
        return null;
      }
    }
    return null;
  },

  async put(input: {
    readonly tenantId: TenantSlug;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    readonly mimeType: ImageMimeType;
    readonly sanitisedFilename: string;
  }): Promise<{ readonly blobUrl: string; readonly contentHash: string }> {
    const key = buildKey(input.tenantId, input.contentHash, input.mimeType);
    const result = await put(key, Buffer.from(input.bytes), {
      access: 'public',
      contentType: input.mimeType,
      token: env.blob.readWriteToken,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return { blobUrl: result.url, contentHash: input.contentHash };
  },
};
