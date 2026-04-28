/**
 * DEV-ONLY — apply T166 R2-S1 migration 0060 (CHECK constraint on
 * `receipt_document_number_raw`). Same drizzle-kit-bypass pattern as
 * `dev-apply-migration-0059.ts` because the journal is wedged.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const lower = url.toLowerCase();
  if (
    process.env.NODE_ENV === 'production' ||
    lower.includes('vercel-storage') ||
    lower.includes('-prod') ||
    lower.includes('.prod.') ||
    lower.includes('-live') ||
    lower.includes('.live.')
  ) {
    throw new Error(
      'REFUSED: production-looking DATABASE_URL. Set DEV_SCRIPT_FORCE=1 to bypass.',
    );
  }
  const client = postgres(url, { max: 1 });
  try {
    const tag = '0060_invoice_receipt_doc_num_check';
    const path = resolve(`drizzle/migrations/${tag}.sql`);
    const sql = readFileSync(path, 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    console.log(`Applying ${tag} (${statements.length} statements)…`);
    for (const stmt of statements) {
      await client.unsafe(stmt);
    }
    console.log(`✓ ${tag} applied`);
  } finally {
    await client.end();
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
