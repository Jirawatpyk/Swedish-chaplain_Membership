/**
 * One-off ops: copy every blob from the OLD (US) public Blob store to the NEW
 * (Singapore) store, PRESERVING each pathname (key) byte-for-byte.
 *
 * Why zero DB changes: the app stores only `pdf_blob_key` (the pathname) and
 * resolves key -> URL via head(key, {token}) at request time. Preserve keys,
 * swap BLOB_READ_WRITE_TOKEN to the new store, redeploy -> every existing PDF +
 * logo resolves against Singapore; `pdf_sha256` still matches (identical bytes).
 *
 * SAFE: reads the old store, writes the new store. Touches NO database, deletes
 * NOTHING. Idempotent + resumable: it lists the target first and SKIPS blobs
 * already copied, and retries transient failures (the public blob CDN throttles
 * ~403/429 under a fast bulk read), so re-running finishes the remaining set.
 *
 * Run from repo root:
 *   node --env-file=.env.production scripts/migrate-blob-us-to-sg.mjs --dry-run
 *   node --env-file=.env.production scripts/migrate-blob-us-to-sg.mjs
 */
import { list, head, put } from '@vercel/blob';

const OLD = process.env.OLD_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;
const DRY = process.argv.includes('--dry-run');

if (!OLD || !NEW) {
  console.error(
    'Missing token(s):\n' +
    `  OLD (US, source)  = OLD_BLOB_TOKEN | BLOB_READ_WRITE_TOKEN    -> ${OLD ? 'found' : 'MISSING'}\n` +
    `  NEW (SG, target)  = NEW_BLOB_TOKEN | SG_READ_WRITE_TOKEN -> ${NEW ? 'found' : 'MISSING'}\n` +
    'Add the MISSING one to .env.production, then re-run with --env-file=.env.production.',
  );
  process.exit(1);
}
if (OLD === NEW) {
  console.error('OLD and NEW tokens are identical — refusing (same store).');
  process.exit(1);
}

// Default: migrate ONLY the production tenant (swecham). Test-tenant junk
// (test-e2e-*, test-*) in this store is throwaway — copying it just re-triggers
// the public-CDN throttle. Pass --all to copy every blob instead.
const REAL_ONLY = !process.argv.includes('--all');
const isReal = (p) => /(^|\/)swecham\//.test(p);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry with exponential backoff — the public blob CDN returns 403/429 under
 * a fast bulk read; waiting lets the rate window reset. */
async function withRetry(fn, tries = 6) {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries) throw e;
      await sleep(delay);
      delay = Math.min(delay * 2, 20_000);
    }
  }
}

async function listAll(token) {
  const set = new Set();
  let cursor;
  do {
    const page = await list({ token, cursor, limit: 1000 });
    for (const b of page.blobs) if (!b.pathname.endsWith('/')) set.add(b.pathname);
    cursor = page.cursor;
  } while (cursor);
  return set;
}

// Resume support: skip anything already in the target store.
const existing = DRY ? new Set() : await listAll(NEW);
if (!DRY) console.log(`target already has ${existing.size} blobs — will skip those.`);

let cursor;
let copied = 0;
let skipped = 0;
let bytes = 0;
const failures = [];

do {
  const page = await list({ token: OLD, cursor, limit: 1000 });
  for (const b of page.blobs) {
    if (b.pathname.endsWith('/')) continue; // folder placeholder
    if (REAL_ONLY && !isReal(b.pathname)) continue; // skip throwaway test junk
    if (existing.has(b.pathname)) { skipped++; continue; }
    try {
      const meta = await withRetry(() => head(b.pathname, { token: OLD }));
      if (DRY) { copied++; bytes += meta.size ?? 0; continue; }
      const body = await withRetry(async () => {
        const res = await fetch(meta.downloadUrl ?? meta.url, { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`GET ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      });
      await withRetry(() =>
        put(b.pathname, body, {
          access: 'public',
          token: NEW,
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: meta.contentType,
        }),
      );
      copied++;
      bytes += body.length;
    } catch (e) {
      failures.push({ pathname: b.pathname, error: e instanceof Error ? e.message : String(e) });
    }
    if ((copied + skipped) % 100 === 0) {
      process.stdout.write(`\r${DRY ? 'counted' : 'copied'}: ${copied}  skipped: ${skipped}  failed: ${failures.length}`);
    }
  }
  cursor = page.cursor;
} while (cursor);

console.log(`\n\n${DRY ? 'DRY RUN — nothing written.' : 'Done.'}`);
console.log(`  ${DRY ? 'would copy' : 'copied'}: ${copied} blobs (${(bytes / 1_000_000).toFixed(1)} MB)`);
console.log(`  skipped (already in target): ${skipped}`);
console.log(`  failed: ${failures.length}`);
if (failures.length) {
  console.log('  first failures:');
  for (const f of failures.slice(0, 40)) console.log(`    ${f.pathname} — ${f.error}`);
  process.exit(2);
}
