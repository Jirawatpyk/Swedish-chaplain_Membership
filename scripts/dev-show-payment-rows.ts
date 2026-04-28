/** DEV-ONLY — list payment rows for an invoice. */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const invoiceId = process.argv[2];
  if (!invoiceId) {
    console.error('Usage: pnpm tsx scripts/dev-show-payment-rows.ts <invoiceId>');
    process.exit(1);
  }
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const rows = await db.execute<{
    id: string;
    status: string;
    processor_payment_intent_id: string;
    actor_user_id: string;
    attempt_seq: number;
  }>(sql`
    SELECT id, status, processor_payment_intent_id, actor_user_id, attempt_seq
    FROM payments
    WHERE invoice_id = ${invoiceId}
    ORDER BY attempt_seq ASC
  `);
  console.table(rows);
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
