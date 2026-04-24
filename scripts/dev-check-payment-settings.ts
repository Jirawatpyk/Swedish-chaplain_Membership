import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const rows = await db.execute<{
    tenant_id: string;
    processor_account_id: string;
    processor_publishable_key: string;
    online_payment_enabled: boolean;
  }>(sql`SELECT tenant_id, processor_account_id, processor_publishable_key, online_payment_enabled FROM tenant_payment_settings`);
  console.table(rows);
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
