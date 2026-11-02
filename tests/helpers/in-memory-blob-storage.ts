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
 *   - `signDownloadUrl` / `downloadBytes` throw `BlobKeyNotFoundError` on a
 *     missing key, as the adapter does for a real store's `head()` miss.
 *   - every write gets a fresh etag, returned by `uploadPdf`; `delete` with a
 *     stale `ifMatch` throws `BlobChangedSinceUploadError` (#60).
 */
import {
  BlobChangedSinceUploadError,
  BlobKeyNotFoundError,
  type BlobStoragePort,
} from '@/modules/invoicing';

export interface InMemoryBlobStorage extends BlobStoragePort {
  /** Keys currently held, sorted — for assertions like "exactly ONE blob". */
  keys(): readonly string[];
  /** Stored bytes for a key, or undefined. */
  bytesFor(key: string): Uint8Array | undefined;
}

export function createInMemoryBlobStorage(): InMemoryBlobStorage {
  const store = new Map<string, { body: Uint8Array; contentType: string; etag: string }>();
  let writes = 0;
  const nextEtag = () => `"mem-${++writes}"`;

  const requireBlob = (key: string) => {
    const blob = store.get(key);
    // The port's own NOT-FOUND class — the one the adapter throws for the
    // SDK's `BlobNotFoundError` and the use cases branch on (`blob_missing`).
    if (blob === undefined) throw new BlobKeyNotFoundError();
    return blob;
  };

  // Stable, key-derived and obviously fake, so a stray assertion against a
  // real Vercel host fails loudly instead of passing by accident.
  const urlFor = (key: string) => `https://blob.test.invalid/${encodeURI(key)}`;

  return {
    async uploadPdf(input) {
      const exists = store.has(input.key);
      const current = store.get(input.key);
      if (exists && current && input.allowOverwrite !== true) {
        return { key: input.key, url: urlFor(input.key), etag: current.etag };
      }
      const etag = nextEtag();
      store.set(input.key, { body: input.body, contentType: input.contentType, etag });
      return { key: input.key, url: urlFor(input.key), etag };
    },

    async uploadLogo(input) {
      store.set(input.key, { body: input.body, contentType: input.contentType, etag: nextEtag() });
      return { key: input.key, url: urlFor(input.key) };
    },

    async signDownloadUrl(key) {
      requireBlob(key);
      return urlFor(key);
    },

    async downloadBytes(key) {
      return requireBlob(key).body;
    },

    async delete(key, options) {
      const current = store.get(key);
      if (options?.ifMatch !== undefined && current && current.etag !== options.ifMatch) {
        throw new BlobChangedSinceUploadError();
      }
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
