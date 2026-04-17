/**
 * One-shot diagnostic: compare drizzle/migrations/meta/_journal.json
 * against the Neon `__drizzle_migrations` tracking table. Prints any
 * drift so we know whether `pnpm db:migrate` will re-apply migrations.
 *
 * Usage: node --env-file=.env.local --import tsx scripts/check-drizzle-journal.ts
 */
import postgres from 'postgres';
import fs from 'node:fs';
import path from 'node:path';

process.loadEnvFile?.('.env.local');

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_UNPOOLED or DATABASE_URL required');
  process.exit(1);
}

async function main() {
  const sql = postgres(url!, { max: 1, ssl: 'require' });
  try {
    const journalPath = path.resolve('drizzle/migrations/meta/_journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    console.log(`Journal: ${journal.entries.length} entries`);
    for (const e of journal.entries) {
      console.log(`  ${String(e.idx).padStart(2, '0')}  ${e.tag}`);
    }

    const dbRows = await sql<
      Array<{ id: number; hash: string; created_at: string }>
    >`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
    console.log(`\n__drizzle_migrations: ${dbRows.length} entries`);
    for (const r of dbRows) {
      console.log(`  ${r.id}  hash=${r.hash.slice(0, 12)}...  at=${new Date(Number(r.created_at)).toISOString()}`);
    }

    console.log(
      `\nDrift: journal has ${journal.entries.length}, DB has ${dbRows.length} → ${
        journal.entries.length === dbRows.length ? 'IN SYNC' : 'OUT OF SYNC'
      }`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
