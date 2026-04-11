/**
 * Quick schema verification against Neon. Lists tables + audit_log
 * triggers so the operator can confirm the migration landed.
 */
// Loaded via `node --env-file=.env.local` from `pnpm db:verify`.
process.loadEnvFile?.('.env.local');

import postgres from 'postgres';

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL;
  if (!url) {
    console.error('verify-schema: DATABASE_URL is required');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, ssl: 'require' });

  try {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `;
    console.log('Tables in public schema:');
    for (const row of tables) {
      console.log(`  ${row.table_name}`);
    }

    // Query pg_trigger directly — information_schema.triggers does NOT
    // list TRUNCATE triggers, so we'd miss audit_log_no_truncate.
    const triggers = await sql<{ tgname: string; tgtype: number }[]>`
      SELECT t.tgname, t.tgtype
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      WHERE c.relname = 'audit_log'
        AND NOT t.tgisinternal
      ORDER BY t.tgname
    `;
    console.log('\nAudit log triggers:');
    for (const row of triggers) {
      // tgtype bits: 0x04=INSERT 0x08=DELETE 0x10=UPDATE 0x20=TRUNCATE
      const events: string[] = [];
      if (row.tgtype & 0x04) events.push('INSERT');
      if (row.tgtype & 0x08) events.push('DELETE');
      if (row.tgtype & 0x10) events.push('UPDATE');
      if (row.tgtype & 0x20) events.push('TRUNCATE');
      console.log(`  ${row.tgname} (${events.join(', ')})`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('verify-schema: crashed:', error);
  process.exit(1);
});
