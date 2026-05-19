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
import type {
  ImageMimeType,
  ImageStoragePort,
} from '../application/ports/image-storage-port';
import type { TenantSlug } from '@/modules/tenants';
import { env } from '@/lib/env';

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
      } catch {
        // not found — try next extension
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
