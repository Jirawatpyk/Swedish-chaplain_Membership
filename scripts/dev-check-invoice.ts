/**
 * DEV-ONLY — diagnostic: show invoice + payment rows for an invoiceId.
 *
 * R5 review-round-3 (2026-04-25): added prod-DB guard. Read-only but
 * the printed PaymentIntent IDs land in shell history + scrollback,
 * which CLAUDE.md § Secrets flags as forbidden in dev terminals when
 * sourced from production data. Override via `DEV_SCRIPT_FORCE=1`.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

function assertNotProduction(databaseUrl: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('REFUSED: NODE_ENV=production. Read-only but PI IDs leak into terminal scrollback.');
  }
  const lower = databaseUrl.toLowerCase();
  if (
    lower.includes('vercel-storage') ||
    lower.includes('-prod') ||
    lower.includes('.prod.') ||
    lower.includes('-live') ||
    lower.includes('.live.')
  ) {
    throw new Error(
      'REFUSED: DATABASE_URL looks like production. Override with DEV_SCRIPT_FORCE=1 if intentional.',
    );
  }
}

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: pnpm tsx scripts/dev-check-invoice.ts <invoiceId>');
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL not set');
  if (process.env.DEV_SCRIPT_FORCE !== '1') assertNotProduction(databaseUrl);
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);
  const inv = await db.execute(sql`SELECT invoice_id, status FROM invoices WHERE invoice_id = ${id}`);
  const pay = await db.execute(sql`SELECT id, method, status, attempt_seq, processor_payment_intent_id, initiated_at FROM payments WHERE invoice_id = ${id} ORDER BY initiated_at DESC LIMIT 20`);
  console.log('invoices:', JSON.stringify(inv, null, 2));
  console.log('payments:', JSON.stringify(pay, null, 2));
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
