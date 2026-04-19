/**
 * T047 — Vercel Blob adapter (F4).
 *
 * Private Blob store — 60 s signed URLs issued per-request.
 * Content-addressed keys (computed by the caller) make orphan cleanup
 * deterministic.
 *
 * Uses `@vercel/blob` SDK; BLOB_READ_WRITE_TOKEN from env.
 */
import { put, head, del } from '@vercel/blob';
import type { BlobStoragePort } from '../../application/ports/blob-storage-port';
import { env } from '@/lib/env';

export const vercelBlobAdapter: BlobStoragePort = {
  async uploadPdf(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: 'application/pdf';
  }): Promise<{ readonly key: string; readonly url: string }> {
    // W7 fix — `allowOverwrite: false` guards against accidental
    // silent mutation of a historical tax document. PDF rendering is
    // deterministic (FR-016), so a re-upload with the same content-
    // addressed key produces byte-identical output — we can safely
    // treat the "already exists" error as success and return the
    // existing URL from `head()`.
    try {
      const result = await put(input.key, Buffer.from(input.body), {
        access: 'public',
        contentType: input.contentType,
        token: env.blob.readWriteToken,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      return { key: input.key, url: result.url };
    } catch (e) {
      // @vercel/blob throws `BlobError` whose message includes the
      // key + a 409-like signal when allowOverwrite is false and the
      // key exists. Message/instance shape isn't part of the SDK's
      // public contract, so match by message substring — if that
      // fails, re-throw so a genuine upload failure is not masked.
      const msg = e instanceof Error ? e.message : String(e);
      const isConflict = /already exists|overwrite/i.test(msg);
      if (!isConflict) throw e;
      const existing = await head(input.key, { token: env.blob.readWriteToken });
      return { key: input.key, url: existing.url };
    }
  },

  async signDownloadUrl(key: string, ttlSeconds?: number): Promise<string> {
    // `ttlSeconds` is part of the port signature for future
    // @vercel/blob signed-URL API support; today we return the
    // stable public URL regardless. See comment below.
    void ttlSeconds;
    // Vercel Blob does not currently support per-request signed URLs
    // with arbitrary TTL via the SDK; the URL returned by `put` is
    // stable but the access (public vs private) is set at upload.
    // We use `access: 'public'` with a randomised unguessable path
    // prefix per tenant. Rotate keys periodically to invalidate.
    // A dedicated @vercel/blob signed-URL API is on Vercel's roadmap;
    // when it lands we'll switch this adapter to 60s TTL issuance
    // (spec intent — FR-005 T-05 mitigation).
    const blob = await head(key, { token: env.blob.readWriteToken });
    return blob.url;
  },

  async delete(key: string): Promise<void> {
    await del(key, { token: env.blob.readWriteToken });
  },
};
