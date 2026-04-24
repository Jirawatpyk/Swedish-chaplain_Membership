/** DEV-ONLY — update tenant_payment_settings.processor_publishable_key. */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

async function main() {
  const pk = process.argv[2];
  if (!pk || !pk.startsWith('pk_')) {
    console.error('Usage: pnpm tsx scripts/dev-update-stripe-pk.ts <pk_test_...>');
    process.exit(1);
  }
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  await db.execute(sql`
    UPDATE tenant_payment_settings
    SET processor_publishable_key = ${pk}, updated_at = NOW()
    WHERE tenant_id = 'swecham'
  `);
  console.log('✓ swecham tenant_payment_settings.processor_publishable_key updated');
  await client.end();
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
