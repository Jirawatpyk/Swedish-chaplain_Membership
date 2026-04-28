import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const result = await db.execute(sql`
    DELETE FROM processor_events
    WHERE outcome = 'acknowledged_only'
  `);
  console.log(`deleted ${result.length} acknowledged_only rows`);
  await client.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
