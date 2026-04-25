/** DEV-ONLY — diagnostic: show invoice + payment rows for an invoiceId. */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: pnpm tsx scripts/dev-check-invoice.ts <invoiceId>');
    process.exit(1);
  }
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const inv = await db.execute(sql`SELECT invoice_id, status FROM invoices WHERE invoice_id = ${id}`);
  const pay = await db.execute(sql`SELECT id, status, attempt_seq, processor_payment_intent_id, initiated_at FROM payments WHERE invoice_id = ${id} ORDER BY initiated_at DESC LIMIT 20`);
  console.log('invoices:', JSON.stringify(inv, null, 2));
  console.log('payments:', JSON.stringify(pay, null, 2));
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
