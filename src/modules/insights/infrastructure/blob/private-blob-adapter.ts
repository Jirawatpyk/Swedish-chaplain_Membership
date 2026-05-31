/**
 * F9 US5/US6 `PrivateBlobPort` Vercel Blob adapter (T069 / research R6).
 *
 * Uses `@vercel/blob` v2 `access:'private'` (confirmed in 2.3.3 types, T004):
 *   - `put(key, body, { access:'private', addRandomSuffix:false, allowOverwrite:true })`
 *     — deterministic per-job key so a reclaim re-run overwrites cleanly.
 *   - `get(key, { access:'private', useCache:false })` — streams the object
 *     server-side; the URL is never handed to the client (the download proxy
 *     pipes the bytes through our own authenticated route).
 *   - `del(key)` — TTL sweep.
 *
 * Uses `env.blob.privateReadWriteToken` — a SEPARATE private-access store from
 * the public `readWriteToken` store (which backs F4 invoice PDFs + F9 logos,
 * all `access:'public'`). A Vercel Blob store is public XOR private, so private
 * export artefacts cannot share the public store (T101a). The token falls back
 * to the public one when no private store is provisioned (dev/test/dark-launch).
 *
 * Blob keys MUST NOT leak into logs/errors (they encode tenant + job path).
 */
import { put, get, del } from '@vercel/blob';
import { env } from '@/lib/env';
import type {
  PrivateBlobObject,
  PrivateBlobPort,
} from '../../application/ports/private-blob-port';

export const privateBlobAdapter: PrivateBlobPort = {
  async putPrivate(input): Promise<{ readonly key: string }> {
    await put(input.key, Buffer.from(input.body), {
      access: 'private',
      contentType: input.contentType,
      token: env.blob.privateReadWriteToken,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return { key: input.key };
  },

  async download(key: string): Promise<PrivateBlobObject | null> {
    const result = await get(key, {
      access: 'private',
      useCache: false,
      token: env.blob.privateReadWriteToken,
    });
    // null = object not found; a null stream (304 ETag match) cannot occur with
    // useCache:false on a fresh fetch — treat it as unavailable defensively.
    if (result === null || result.stream === null) return null;
    return { stream: result.stream, contentType: result.blob.contentType };
  },

  async delete(key: string): Promise<void> {
    await del(key, { token: env.blob.privateReadWriteToken });
  },
};
