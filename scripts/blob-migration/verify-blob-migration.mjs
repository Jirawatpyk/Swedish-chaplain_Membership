/**
 * Verify the US -> SG blob copy: list both stores, report which US pathnames
 * are MISSING from SG, split into throwaway E2E test junk vs REAL data.
 * Read-only (list only). Run: node --env-file=.env.production scripts/verify-blob-migration.mjs
 */
import { list } from '@vercel/blob';

const OLD = process.env.OLD_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;
if (!OLD || !NEW) { console.error('Missing OLD/NEW blob tokens.'); process.exit(1); }

async function allPaths(token) {
  const set = new Set();
  let cursor;
  do {
    const p = await list({ token, cursor, limit: 1000 });
    for (const b of p.blobs) if (!b.pathname.endsWith('/')) set.add(b.pathname);
    cursor = p.cursor;
  } while (cursor);
  return set;
}

// REAL = the production tenant `swecham` exactly (as a path segment). Every
// `test-*` tenant — including `test-swecham-<hash>` from integration runs — is
// throwaway. Gate pass/fail ONLY on real swecham blobs.
const isReal = (p) => /(^|\/)swecham\//.test(p);

const us = await allPaths(OLD);
const sg = await allPaths(NEW);

let realUs = 0, testUs = 0, missingReal = 0, missingTest = 0;
const missingRealList = [];
for (const p of us) {
  const real = isReal(p);
  if (real) realUs++; else testUs++;
  if (!sg.has(p)) {
    if (real) { missingReal++; if (missingRealList.length < 40) missingRealList.push(p); }
    else missingTest++;
  }
}

console.log('US total blobs :', us.size, `(swecham prod: ${realUs}, throwaway-test: ${testUs})`);
console.log('SG total blobs :', sg.size);
console.log('MISSING from SG: swecham prod =', missingReal, '| throwaway-test =', missingTest);
if (missingReal > 0) {
  console.log('\n!!! swecham PROD blobs missing from SG (must be 0):');
  for (const p of missingRealList) console.log('  ' + p);
  process.exit(2);
}
console.log('\nOK — every swecham PROD blob is present in Singapore.');
