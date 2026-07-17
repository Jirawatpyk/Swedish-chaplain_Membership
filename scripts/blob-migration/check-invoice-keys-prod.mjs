/**
 * READ-ONLY prod audit: the DATABASE is the source of truth for "how many real
 * invoices". Count swecham invoices/credit-notes and collect every blob key the
 * app actually references, then check which are missing from the SG store.
 * No writes. Run: node --env-file=.env.production scripts/check-invoice-keys-prod.mjs
 */
import postgres from 'postgres';
import { list } from '@vercel/blob';

const url = process.env.DATABASE_URL;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;
if (!url) { console.error('No DATABASE_URL'); process.exit(1); }

const sql = postgres(url, { max: 1 });
try {
  // Scope RLS to the prod tenant (slug), same GUC the app uses.
  await sql`SELECT set_config('app.current_tenant', 'swecham', false)`;

  const [inv] = await sql`SELECT count(*)::int AS n FROM invoices`;
  const [invPdf] = await sql`SELECT count(*)::int AS n FROM invoices WHERE pdf_blob_key IS NOT NULL`;
  const [invRcpt] = await sql`SELECT count(*)::int AS n FROM invoices WHERE receipt_pdf_blob_key IS NOT NULL`;
  const [cn] = await sql`SELECT count(*)::int AS n FROM credit_notes`;

  const keys = new Set();
  const addKeys = (rows, col) => rows.forEach((r) => r[col] && keys.add(r[col]));
  addKeys(await sql`SELECT pdf_blob_key FROM invoices WHERE pdf_blob_key IS NOT NULL`, 'pdf_blob_key');
  addKeys(await sql`SELECT receipt_pdf_blob_key FROM invoices WHERE receipt_pdf_blob_key IS NOT NULL`, 'receipt_pdf_blob_key');
  addKeys(await sql`SELECT zero_rate_cert_blob_key FROM invoices WHERE zero_rate_cert_blob_key IS NOT NULL`, 'zero_rate_cert_blob_key');
  addKeys(await sql`SELECT pdf_blob_key FROM credit_notes WHERE pdf_blob_key IS NOT NULL`, 'pdf_blob_key');
  addKeys(await sql`SELECT logo_blob_key FROM tenant_invoice_settings WHERE logo_blob_key IS NOT NULL`, 'logo_blob_key');

  console.log('=== DB (source of truth, tenant=swecham) ===');
  console.log('invoices rows          :', inv.n, `(with PDF: ${invPdf.n}, with receipt: ${invRcpt.n})`);
  console.log('credit_notes rows      :', cn.n);
  console.log('DISTINCT blob keys used :', keys.size, '(invoice PDF + receipt + zero-rate cert + credit-note + logo)');

  // Which of those DB-referenced keys are already in the SG store?
  const sg = new Set();
  let cursor;
  do {
    const p = await list({ token: NEW, cursor, limit: 1000 });
    for (const b of p.blobs) sg.add(b.pathname);
    cursor = p.cursor;
  } while (cursor);

  const missing = [...keys].filter((k) => !sg.has(k));
  console.log('\n=== vs Singapore store ===');
  console.log('SG store blobs         :', sg.size);
  console.log('DB keys MISSING in SG  :', missing.length);
  if (missing.length) {
    for (const k of missing.slice(0, 80)) console.log('  ' + k);
    if (missing.length > 80) console.log(`  ...and ${missing.length - 80} more`);
  } else {
    console.log('\nOK — every blob the DB references is present in Singapore.');
  }
} finally {
  await sql.end();
}
