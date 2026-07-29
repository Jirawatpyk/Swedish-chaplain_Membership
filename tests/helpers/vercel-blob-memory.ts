/**
 * In-memory stand-in for the `@vercel/blob` SDK.
 *
 * WHY THIS EXISTS (2026-07-29)
 * The first nightly `renewals` sweep failed 19 tests across 5 files, every one
 * of them on `Vercel Blob: This store does not exist.` — `blob_upload_failed`.
 * Those suites drive the real F4 issue path, which uploads a rendered PDF, and
 * CI's `BLOB_READ_WRITE_TOKEN` comes from `.env.example`, i.e. a placeholder
 * pointing at no store. They passed on a laptop only because `.env.local`
 * carries a live dev-store token — so they were also uploading test PDFs into
 * that store on every local run.
 *
 * The mock is at the SDK boundary, NOT at our `BlobStoragePort`: the adapter's
 * own logic — the deterministic-re-upload conflict branch, the allowOverwrite
 * re-throw, the `head()`-then-`fetch()` read — stays under test. Only the
 * network and the store are replaced.
 *
 * Usage (top of an integration test file):
 *
 *   vi.mock('@vercel/blob', () => import('../../helpers/vercel-blob-memory'));
 *
 * The store is module state, so vitest's per-file isolation gives every test
 * file a fresh, empty one.
 */

interface StoredBlob {
  readonly body: Buffer;
  readonly contentType: string;
}

const store = new Map<string, StoredBlob>();

/**
 * `data:` rather than a fake `https://…` host so the adapter's
 * `downloadBytes` (which does `fetch(blob.url)`) keeps working unchanged —
 * Node's fetch reads data URLs. Nothing persists this value: the invoicing
 * schema stores blob KEYS only, never the URL.
 */
function urlFor(key: string): string {
  const blob = store.get(key);
  if (!blob) throw notFound();
  return `data:${blob.contentType};base64,${blob.body.toString('base64')}`;
}

function notFound(): Error {
  // The real SDK throws `BlobNotFoundError`; callers match on the name, so
  // reproduce that rather than a bare Error.
  const err = new Error('Vercel Blob: The requested blob does not exist');
  err.name = 'BlobNotFoundError';
  return err;
}

export async function put(
  key: string,
  body: Buffer | Uint8Array | string,
  options: { readonly contentType?: string; readonly allowOverwrite?: boolean } = {},
): Promise<{ readonly url: string; readonly pathname: string; readonly contentType: string }> {
  const exists = store.has(key);
  if (exists && options.allowOverwrite !== true) {
    // Message must satisfy the adapter's `/already exists|overwrite/i` test so
    // the deterministic-re-upload branch is exercised exactly as in production.
    throw new Error(
      'Vercel Blob: This blob already exists, use allowOverwrite: true to overwrite it',
    );
  }
  const contentType = options.contentType ?? 'application/octet-stream';
  store.set(key, { body: Buffer.from(body as Uint8Array), contentType });
  return { url: urlFor(key), pathname: key, contentType };
}

export async function head(
  key: string,
): Promise<{ readonly url: string; readonly pathname: string; readonly size: number; readonly contentType: string }> {
  const blob = store.get(key);
  if (!blob) throw notFound();
  return {
    url: urlFor(key),
    pathname: key,
    size: blob.body.byteLength,
    contentType: blob.contentType,
  };
}

export async function del(keys: string | readonly string[]): Promise<void> {
  for (const key of Array.isArray(keys) ? keys : [keys as string]) {
    store.delete(key);
  }
}

export async function list(options: {
  readonly prefix?: string;
  readonly limit?: number;
}): Promise<{ readonly blobs: ReadonlyArray<{ readonly pathname: string }> }> {
  const prefix = options.prefix ?? '';
  const matched = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
  // The port contract says implementations MUST cap at `limit` and MUST NOT
  // paginate — mirror that here so a caller relying on the cap behaves the same
  // against the fake as against the real store.
  const limit = options.limit ?? matched.length;
  return { blobs: matched.slice(0, limit).map((pathname) => ({ pathname })) };
}

/** Escape hatch for a suite that wants to assert on stored objects. */
export function __blobStoreKeys(): readonly string[] {
  return [...store.keys()].sort();
}
