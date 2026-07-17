/** READ-ONLY: confirm the SG store actually SERVES real invoice PDFs (HTTP 200). */
import postgres from 'postgres';
import { head } from '@vercel/blob';
const url = process.env.DATABASE_URL;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;

const sql = postgres(url, { max: 1 });
try {
  await sql`SELECT set_config('app.current_tenant', 'swecham', false)`;
  const rows = await sql`SELECT document_number, pdf_blob_key FROM invoices WHERE pdf_blob_key IS NOT NULL ORDER BY created_at DESC LIMIT 3`;
  for (const r of rows) {
    const h = await head(r.pdf_blob_key, { token: NEW });   // SG store
    const res = await fetch(h.url, { cache: 'no-store' });
    console.log(`${r.document_number ?? '(no #)'}  ${r.pdf_blob_key.slice(0, 60)}...`);
    console.log(`   SG serve: HTTP ${res.status}  (${h.size} bytes, ${h.contentType})`);
  }
} finally { await sql.end(); }
