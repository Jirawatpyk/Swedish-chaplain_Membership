/**
 * One-off: apply migration 0074 (broadcasts plan_id_snapshot text fix).
 * Run via:  pnpm tsx scripts/apply-migration-0074.ts
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

async function main(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL missing');
    process.exit(1);
  }
  const migrationSql = readFileSync(
    process.argv[2] ??
      'drizzle/migrations/0074_alter_broadcasts_plan_id_snapshot_text.sql',
    'utf8',
  );
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    await sql.unsafe(migrationSql);
    console.log('[migration 0074] applied OK');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error('[migration 0074] failed:', e);
  process.exit(1);
});
