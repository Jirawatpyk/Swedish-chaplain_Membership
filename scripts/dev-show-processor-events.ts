import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
async function main() {
  const client = postgres(process.env.DATABASE_URL!, { max: 1 });
  const db = drizzle(client);
  const rows = await db.execute<{id:string;event_type:string;outcome:string;processed_at:string}>(sql`
    SELECT id, event_type, outcome, processed_at FROM processor_events
    ORDER BY processed_at DESC NULLS LAST LIMIT 10
  `);
  console.table(rows);
  await client.end();
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
