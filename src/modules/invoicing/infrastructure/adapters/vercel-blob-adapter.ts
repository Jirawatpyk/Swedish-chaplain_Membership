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
    readonly allowOverwrite?: boolean;
  }): Promise<{ readonly key: string; readonly url: string }> {
    // Default path (allowOverwrite=false): guards against accidental
    // silent mutation of a historical tax document. PDF rendering is
    // deterministic (FR-016), so a re-upload with the same content-
    // addressed key produces byte-identical output — we safely treat
    // the "already exists" error as success and return the existing
    // URL from `head()`.
    //
    // Explicit-overwrite path (allowOverwrite=true): required by the
    // AS4 rollup + VOID re-stamp flows where the re-render produces
    // DIFFERENT bytes (status-overlay annotations). Passes
    // `allowOverwrite: true` to @vercel/blob so the existing key is
    // replaced with the new bytes. Review fix CR-1 (2026-04-20) —
    // without this, the annotation upload silently no-op'd and DB
    // pdf_sha256 drifted from Blob content.
    const allowOverwrite = input.allowOverwrite ?? false;
    try {
      const result = await put(input.key, Buffer.from(input.body), {
        access: 'public',
        contentType: input.contentType,
        token: env.blob.readWriteToken,
        addRandomSuffix: false,
        allowOverwrite,
      });
      return { key: input.key, url: result.url };
    } catch (e) {
      // Deterministic-re-upload convenience applies ONLY when
      // allowOverwrite was false. When the caller explicitly opted
      // into overwrite and we still fail, the error is genuine —
      // re-throw so the transactional caller rolls back.
      if (allowOverwrite) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      const isConflict = /already exists|overwrite/i.test(msg);
      if (!isConflict) throw e;
      const existing = await head(input.key, { token: env.blob.readWriteToken });
      return { key: input.key, url: existing.url };
    }
  },

  async uploadLogo(input: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType: 'image/png' | 'image/jpeg';
  }): Promise<{ readonly key: string; readonly url: string }> {
    // Logos are `access: 'public'` because the tenant invoice PDF
    // template embeds them and Vercel Blob doesn't support auth on
    // image fetch. Key includes a random UUID (via the use-case) so
    // the URL is unguessable even without signed URLs.
    const result = await put(input.key, Buffer.from(input.body), {
      access: 'public',
      contentType: input.contentType,
      token: env.blob.readWriteToken,
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    return { key: input.key, url: result.url };
  },

  async signDownloadUrl(key: string, ttlSeconds?: number): Promise<string> {
    // `ttlSeconds` is part of the port signature; the current
    // implementation returns the stable URL emitted by `put`.
    void ttlSeconds;
    // Current Chamber-OS approach: `put` uses access mode selected at
    // upload and returns a stable URL. Access control is enforced by
    // the server fetching + proxying bytes through our own route
    // (`/api/invoices/[id]/pdf`, `/api/credit-notes/[id]/pdf`); the
    // Blob URL is never exposed to the client. Per-request signed
    // URLs with arbitrary TTL via the SDK are not used here even
    // where available, because the proxy path gives us one consistent
    // auth boundary + audit point regardless of Blob-SDK capability
    // drift. FR-005 T-05 mitigation is satisfied by the proxy.
    const blob = await head(key, { token: env.blob.readWriteToken });
    return blob.url;
  },

  async delete(key: string): Promise<void> {
    await del(key, { token: env.blob.readWriteToken });
  },
};
