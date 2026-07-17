/** Diagnose why tenants/swecham/invoices/* blobs 403 on fetch. Read-only. */
import { list, head } from '@vercel/blob';
const OLD = process.env.OLD_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;

async function probe(prefix, n = 2) {
  console.log(`\n=== prefix: ${prefix} ===`);
  const page = await list({ token: OLD, prefix, limit: n });
  if (!page.blobs.length) { console.log('  (no blobs)'); return; }
  for (const b of page.blobs.slice(0, n)) {
    const h = await head(b.pathname, { token: OLD });
    console.log(b.pathname);
    console.log('   contentType:', h.contentType, '| size:', h.size);
    console.log('   url        :', h.url);
    console.log('   downloadUrl:', h.downloadUrl);
    for (const [label, u] of [['url', h.url], ['downloadUrl', h.downloadUrl]]) {
      if (!u) continue;
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
        console.log(`   fetch ${label} -> HTTP ${r.status}`);
      } catch (e) {
        console.log(`   fetch ${label} -> ERR ${e instanceof Error ? e.message : e}`);
      }
    }
  }
}

await probe('tenants/swecham/invoices/');   // real prod invoices (missing)
await probe('invoicing/');                   // old-scheme (mostly copied ok)
