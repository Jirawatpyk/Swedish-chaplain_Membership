/**
 * READ-ONLY full audit of EVERYTHING tenant `swecham` keeps in the public Blob
 * store, checked against the SG store. DB is source of truth for key-based refs;
 * content-hash prefixes cover the URL-embedded categories. No writes.
 * Run: node --env-file=.env.production scripts/audit-all-prod-blobs.mjs
 */
import postgres from 'postgres';
import { list } from '@vercel/blob';

const url = process.env.DATABASE_URL;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;
const OLD = process.env.OLD_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;

async function listPrefix(token, prefix) {
  const s = new Set(); let c;
  do { const p = await list({ token, cursor: c, limit: 1000, prefix }); for (const b of p.blobs) if (!b.pathname.endsWith('/')) s.add(b.pathname); c = p.cursor; } while (c);
  return s;
}
async function listAll(token) {
  const s = new Set(); let c;
  do { const p = await list({ token, cursor: c, limit: 1000 }); for (const b of p.blobs) if (!b.pathname.endsWith('/')) s.add(b.pathname); c = p.cursor; } while (c);
  return s;
}

const sql = postgres(url, { max: 1 });
const missingByCat = {};
try {
  await sql`SELECT set_config('app.current_tenant', 'swecham', false)`;
  const sg = await listAll(NEW);

  // --- key-based (DB source of truth) ---
  const dbKeys = new Set();
  const addKeys = (rows, col) => rows.forEach((r) => r[col] && dbKeys.add(r[col]));
  addKeys(await sql`SELECT pdf_blob_key FROM invoices WHERE pdf_blob_key IS NOT NULL`, 'pdf_blob_key');
  addKeys(await sql`SELECT receipt_pdf_blob_key FROM invoices WHERE receipt_pdf_blob_key IS NOT NULL`, 'receipt_pdf_blob_key');
  addKeys(await sql`SELECT zero_rate_cert_blob_key FROM invoices WHERE zero_rate_cert_blob_key IS NOT NULL`, 'zero_rate_cert_blob_key');
  addKeys(await sql`SELECT pdf_blob_key FROM credit_notes WHERE pdf_blob_key IS NOT NULL`, 'pdf_blob_key');
  addKeys(await sql`SELECT logo_blob_key FROM tenant_invoice_settings WHERE logo_blob_key IS NOT NULL`, 'logo_blob_key');
  const invoiceKeyCount = dbKeys.size;

  const dirLogos = new Set();
  (await sql`SELECT logo_blob_key FROM directory_listings WHERE logo_blob_key IS NOT NULL`).forEach((r) => dirLogos.add(r.logo_blob_key));

  // --- prefix-based (URL-embedded categories, this store) ---
  const bcastImgs = await listPrefix(OLD, 'broadcasts/images/swecham/');
  const errCsvs = await listPrefix(OLD, 'tenants/swecham/csv-import-errors/');

  // F6 error-CSV DB refs (URL column, informational)
  const [errRefs] = await sql`SELECT count(*)::int AS n FROM csv_import_records WHERE error_csv_blob_url IS NOT NULL`.catch(() => [{ n: -1 }]);

  const check = (label, keys) => {
    const miss = [...keys].filter((k) => !sg.has(k));
    missingByCat[label] = miss;
    console.log(`${label}: ${keys.size} refs, ${miss.length} MISSING from SG`);
    for (const k of miss.slice(0, 20)) console.log('    - ' + k);
    if (miss.length > 20) console.log(`    ...+${miss.length - 20} more`);
  };

  console.log('=== tenant=swecham, checked against SG ===');
  console.log(`invoice/receipt/cert/CN/invoice-logo (DB keys): ${invoiceKeyCount} refs`);
  check('  invoice+logo keys        ', dbKeys);
  check('  directory listing logos  ', dirLogos);
  check('  broadcast images (prefix)', bcastImgs);
  check('  F6 error-CSV (prefix,TTL)', errCsvs);
  console.log(`\n(F6 csv_import_records rows with error_csv_blob_url: ${errRefs.n} — URL-based, 30-day TTL, ephemeral)`);

  const totalMissing = Object.entries(missingByCat)
    .filter(([k]) => !k.includes('error-CSV'))
    .reduce((n, [, v]) => n + v.length, 0);
  console.log(`\n>>> PERMANENT data missing from SG (excl. ephemeral CSVs): ${totalMissing}`);
} finally {
  await sql.end();
}
