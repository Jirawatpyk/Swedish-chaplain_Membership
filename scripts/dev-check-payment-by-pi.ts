import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const rows = await db.execute<{
    id: string;
    tenant_id: string;
    status: string;
    processor_payment_intent_id: string;
  }>(sql`
    SELECT id, tenant_id, status, processor_payment_intent_id
    FROM payments
    WHERE processor_payment_intent_id = 'pi_3TPlsC2HOqs9a0JA0vddeMIj'
  `);
  console.table(rows);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
