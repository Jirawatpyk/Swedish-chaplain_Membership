/**
 * One-off: apply migration 0018 (outbox_permanent_updated_idx).
 *
 * The project's `drizzle-kit migrate` has pre-existing snapshot drift
 * that pre-dates Path C (several snapshot JSONs in
 * drizzle/migrations/meta/ are missing between 0009 and 0017). Using
 * drizzle-kit to apply 0018 triggers it to re-run earlier migrations
 * and error on DefineEnum 42710.
 *
 * The SQL itself is idempotent (`CREATE INDEX IF NOT EXISTS`), so this
 * script just calls `db.execute()` with the exact statement from
 * `drizzle/migrations/0018_soft_franklin_richards.sql`. Safe to re-run.
 */
import { sql } from 'drizzle-orm';
import { db } from '../src/lib/db';

async function main() {
  console.log('Applying migration 0018_outbox_permanent_updated_idx...');
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "outbox_permanent_updated_idx"
      ON "notifications_outbox" ("updated_at")
      WHERE "status" = 'permanently_failed'
  `);
  console.log('✓ Index applied (created or already existed)');

  const rows = (await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'notifications_outbox'
    ORDER BY indexname
  `)) as unknown as Array<{ indexname: string }>;
  console.log('Indexes on notifications_outbox:');
  for (const row of rows) {
    console.log('  -', row.indexname);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
