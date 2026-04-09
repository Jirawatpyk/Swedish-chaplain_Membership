/**
 * Apply pending Drizzle migrations to the configured database (T025).
 *
 * Usage: `pnpm db:migrate`
 *
 * Reads `.env.local` so the same command works locally and in CI without
 * extra wrapper scripts. Uses the *unpooled* connection because pooled
 * Neon connections can interfere with schema-changing statements.
 *
 * Migrations live in `drizzle/migrations/`. The Drizzle journal
 * (`drizzle/migrations/meta/_journal.json`) tracks which ones have been
 * applied — re-running this command is idempotent.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Loaded via `node --env-file=.env.local` from `pnpm db:migrate`.
// The fallback below covers direct `tsx` invocations.
process.loadEnvFile?.('.env.local');

const url =
  process.env.DATABASE_URL_UNPOOLED ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.DATABASE_URL;

if (!url) {
  console.error(
    'scripts/run-migrations.ts: DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const client = postgres(url!, {
    max: 1,
    ssl: 'require',
    connection: { statement_timeout: 30_000 } as Record<string, string | number>,
  });
  const db = drizzle(client);

  try {
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    console.log('✓ Migrations applied');
  } catch (error) {
    console.error('✗ Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('run-migrations: crashed:', error);
  process.exit(1);
});
