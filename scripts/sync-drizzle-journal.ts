/**
 * Sync __drizzle_migrations using drizzle-kit's own hashing.
 *
 * drizzle-kit `migrate` compares journal hashes using a specific
 * algorithm (sha256 of statements joined by `--> statement-breakpoint`
 * stripped). Raw `sha256(fileContents)` does not match, so the journal
 * our previous apply script populated is rejected and drizzle-kit
 * tries to replay every migration.
 *
 * This script reuses drizzle-orm's own migration utility to populate
 * __drizzle_migrations with the correct hashes, marking everything as
 * already-applied without actually executing any SQL.
 */
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

process.loadEnvFile?.('.env.local');

const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL;
if (!url) {
  console.error('sync-drizzle-journal: DATABASE_URL is required.');
  process.exit(1);
}

const MIGRATIONS_DIR = resolve(process.cwd(), 'drizzle/migrations');

async function main(): Promise<void> {
  const client = postgres(url!, { max: 1, ssl: 'require' });
  try {
    // drizzle.config.ts specifies table='drizzle_migrations' schema='public'
    // (NO leading __ prefix, in the public schema — not the drizzle
    // schema convention that drizzle-orm's library default uses).
    await client.unsafe(`
      CREATE TABLE IF NOT EXISTS public.drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);
    // Wipe any previous bad hashes we wrote.
    await client.unsafe('TRUNCATE public.drizzle_migrations');
    // Also clean up any old tracking tables from earlier attempts.
    await client.unsafe('DROP TABLE IF EXISTS drizzle.__drizzle_migrations');

    // Parse journal for ordering.
    const journal = JSON.parse(
      readFileSync(resolve(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string; when: number }> };

    // Drizzle-kit hashes each migration as:
    //   sha256( statements.map(s => s.trim()).filter(s => s).join('') )
    // where statements are split on `--> statement-breakpoint`.
    // Also strip trailing newlines / comments-only segments.
    for (const entry of journal.entries.sort((a, b) => a.idx - b.idx)) {
      const sqlPath = resolve(MIGRATIONS_DIR, `${entry.tag}.sql`);
      const content = readFileSync(sqlPath, 'utf8');
      // drizzle-orm/migrator.cjs readMigrationFiles:
      //   hash = createHash('sha256').update(query).digest('hex')
      // where `query` is the raw file contents. Not split, not trimmed.
      const hash = createHash('sha256').update(content).digest('hex');
      await client`
        INSERT INTO public.drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
      console.log(`  ✓ ${entry.tag} → ${hash.slice(0, 12)}…`);
    }
    console.log(`\n✓ Journal synced with ${journal.entries.length} entries.`);
  } catch (error) {
    console.error('✗ sync-drizzle-journal crashed:', error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main();
