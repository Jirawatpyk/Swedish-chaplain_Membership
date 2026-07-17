/** READ-ONLY: confirm the invoice logo blob is present in SG. */
import postgres from 'postgres';
import { head } from '@vercel/blob';
const url = process.env.DATABASE_URL;
const NEW = process.env.NEW_BLOB_TOKEN || process.env.SG_READ_WRITE_TOKEN;
const OLD = process.env.OLD_BLOB_TOKEN || process.env.BLOB_READ_WRITE_TOKEN;

const sql = postgres(url, { max: 1 });
try {
  await sql`SELECT set_config('app.current_tenant', 'swecham', false)`;
  const rows = await sql`SELECT logo_blob_key FROM tenant_invoice_settings WHERE logo_blob_key IS NOT NULL`;
  if (!rows.length) { console.log('No invoice logo set in DB (tenant renders text-only header).'); process.exit(0); }
  for (const r of rows) {
    const key = r.logo_blob_key;
    console.log('invoice logo key:', key);
    for (const [label, token] of [['US', OLD], ['SG', NEW]]) {
      try { const h = await head(key, { token }); console.log(`   ${label}: PRESENT (size ${h.size}, ${h.contentType})`); }
      catch (e) { console.log(`   ${label}: MISSING (${e instanceof Error ? e.message : e})`); }
    }
  }
} finally { await sql.end(); }
