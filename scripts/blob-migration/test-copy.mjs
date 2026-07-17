/** Test whether @vercel/blob copy() can move a blob cross-store (US url -> SG
 * token) server-side, bypassing the client-side CDN throttle. */
import { list, head, copy } from '@vercel/blob';
const OLD = process.env.OLD_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;

const page = await list({ token: OLD, prefix: 'tenants/swecham/invoices/', limit: 1 });
const b = page.blobs[0];
const h = await head(b.pathname, { token: OLD });
console.log('source:', b.pathname);
console.log('url   :', h.url);
try {
  const res = await copy(h.url, b.pathname, {
    access: 'public',
    token: NEW,
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: h.contentType,
  });
  console.log('copy() OK ->', res.url);
  // Confirm it landed in SG
  const check = await head(b.pathname, { token: NEW });
  console.log('verified in SG: size', check.size, '(source size', h.size, ')');
} catch (e) {
  console.log('copy() ERR:', e instanceof Error ? e.message : e);
}
