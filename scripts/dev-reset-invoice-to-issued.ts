/** DEV-ONLY — reset an invoice + its payment rows back to issued/canceled for re-testing. */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId) {
    console.error('Usage: pnpm tsx scripts/dev-reset-invoice-to-issued.ts <invoiceId>');
    process.exit(1);
  }
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  await db.execute(sql`UPDATE payments SET status = 'canceled', completed_at = NOW() WHERE invoice_id = ${invoiceId} AND status IN ('pending','succeeded')`);
  await db.execute(sql`UPDATE invoices SET status = 'issued', paid_at = NULL, payment_method = NULL WHERE invoice_id = ${invoiceId}`);
  console.log(`✓ reset invoice ${invoiceId} to issued`);
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
