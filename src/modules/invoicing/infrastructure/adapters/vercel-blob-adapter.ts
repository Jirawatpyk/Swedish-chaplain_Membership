/**
 * T047 — Vercel Blob adapter (F4).
 *
 * Private Blob store — 60 s signed URLs issued per-request.
 * Content-addressed keys (computed by the caller) make orphan cleanup
 * deterministic.
 *
 * Uses `@vercel/blob` SDK; BLOB_READ_WRITE_TOKEN from env.
 */
import { put, head, del, list } from '@vercel/blob';
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

  async signDownloadUrl(key: string): Promise<string> {
    // Chamber-OS approach: `put` uses access mode selected at
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

  async downloadBytes(key: string): Promise<Uint8Array> {
    // FR-036 — fetch the stored PDF bytes so the outbox dispatcher can
    // attach them to the cancellation email. We go through `head()` +
    // `fetch()` (not `get`, which the @vercel/blob SDK does not expose
    // for server-side reads at this version) to stay compatible with
    // the same access-mode the adapter uploads with (`public`).
    const blob = await head(key, { token: env.blob.readWriteToken });
    // PG-1 — `cache: 'no-store'` avoids serving stale bytes from a CDN
    // layer after the VOID overlay overwrite.
    const response = await fetch(blob.url, { cache: 'no-store' });
    if (!response.ok) {
      // PG-1 — DO NOT embed the Blob key in the thrown message: keys
      // contain tenant + invoice path segments that must not leak into
      // Vercel logs via any default error serialiser.
      throw new Error(
        `vercel-blob downloadBytes: HTTP ${response.status} fetching invoice PDF`,
      );
    }
    const ab = await response.arrayBuffer();
    return new Uint8Array(ab);
  },

  async delete(key: string): Promise<void> {
    await del(key, { token: env.blob.readWriteToken });
  },

  async list(prefix: string, limit: number): Promise<readonly string[]> {
    // T092b — caller-named bound per port contract. For the logo cap
    // (50), callers pass ≥ 51 so the count gate distinguishes
    // "exactly at cap" from "over cap".
    const result = await list({
      prefix,
      limit,
      token: env.blob.readWriteToken,
    });
    return result.blobs.map((b) => b.pathname);
  },
};
