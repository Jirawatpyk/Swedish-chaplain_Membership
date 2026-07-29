/**
 * In-memory `BlobStoragePort` for integration suites that drive the real F4
 * issue path.
 *
 * WHY (2026-07-29): the first nightly `renewals` sweep failed 19 tests across
 * 5 files, all on `Vercel Blob: This store does not exist.` CI's
 * `BLOB_READ_WRITE_TOKEN` comes from `.env.example` — a placeholder pointing at
 * no store — while a laptop's `.env.local` holds a live dev-store token, so
 * those suites had been silently depending on a real external service (and
 * uploading test PDFs into it on every local run).
 *
 * Injected through `makeRenewalsDeps(slug, { blob })`; the invoicing suites
 * that already pass in CI do the same thing with their own doubles. Behaviour
 * mirrors `vercel-blob-adapter.ts` where the callers can observe it:
 *
 *   - `uploadPdf` without `allowOverwrite` on an existing key resolves to the
 *     STORED bytes' URL rather than replacing them — the adapter's
 *     deterministic-re-upload contract (same key ⇒ same bytes).
 *   - `uploadPdf` with `allowOverwrite: true` replaces the bytes, which the
 *     VOID re-stamp path depends on.
 *   - `signDownloadUrl` / `downloadBytes` throw on a missing key, as a real
 *     store's `head()` does.
 */
import type { BlobStoragePort } from '@/modules/invoicing';

export interface InMemoryBlobStorage extends BlobStoragePort {
  /** Keys currently held, sorted — for assertions like "exactly ONE blob". */
  keys(): readonly string[];
  /** Stored bytes for a key, or undefined. */
  bytesFor(key: string): Uint8Array | undefined;
}

export function createInMemoryBlobStorage(): InMemoryBlobStorage {
  const store = new Map<string, { body: Uint8Array; contentType: string }>();

  const requireBlob = (key: string) => {
    const blob = store.get(key);
    if (blob === undefined) {
      const err = new Error('in-memory blob storage: no such key');
      err.name = 'BlobNotFoundError';
      throw err;
    }
    return blob;
  };

  // Stable, key-derived and obviously fake, so a stray assertion against a
  // real Vercel host fails loudly instead of passing by accident.
  const urlFor = (key: string) => `https://blob.test.invalid/${encodeURI(key)}`;

  return {
    async uploadPdf(input) {
      const exists = store.has(input.key);
      if (exists && input.allowOverwrite !== true) {
        return { key: input.key, url: urlFor(input.key) };
      }
      store.set(input.key, { body: input.body, contentType: input.contentType });
      return { key: input.key, url: urlFor(input.key) };
    },

    async uploadLogo(input) {
      store.set(input.key, { body: input.body, contentType: input.contentType });
      return { key: input.key, url: urlFor(input.key) };
    },

    async signDownloadUrl(key) {
      requireBlob(key);
      return urlFor(key);
    },

    async downloadBytes(key) {
      return requireBlob(key).body;
    },

    async delete(key) {
      store.delete(key);
    },

    async list(prefix, limit) {
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .sort()
        .slice(0, limit);
    },

    keys() {
      return [...store.keys()].sort();
    },

    bytesFor(key) {
      return store.get(key)?.body;
    },
  };
}
