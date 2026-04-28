import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const rows = await db.execute(sql`
    SELECT tenant_id,
           processor_account_id,
           processor_publishable_key,
           online_payment_enabled,
           enabled_methods,
           promptpay_qr_expiry_seconds
    FROM tenant_payment_settings
  `);
  console.log(JSON.stringify(rows, null, 2));
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
