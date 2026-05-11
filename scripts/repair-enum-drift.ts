/**
 * Repair script — re-applies every `ALTER TYPE ... ADD VALUE IF NOT EXISTS`
 * statement found across `drizzle/migrations/*.sql` using an autocommit
 * connection (no implicit transaction wrap).
 *
 * Background — why this script exists:
 *   PostgreSQL forbids `ALTER TYPE ADD VALUE` inside a transaction. The
 *   drizzle-orm migrator (`drizzle-orm/postgres-js/migrator`) wraps every
 *   migration file in `BEGIN; ... COMMIT;`. When a test environment ends
 *   up with partial state (e.g. journal lists migration as applied, but
 *   the enum row is absent in `pg_enum`), simply re-running the migration
 *   does not recover — the journal short-circuits the migrate function
 *   before reaching the SQL.
 *
 *   QA report TC-013 documented this: migration 0112's enum value
 *   `cron_bearer_auth_rejected` was listed in `_journal.json` but
 *   missing from `pg_enum`. Production deploys against a fresh DB are
 *   unaffected (the FIRST run inside drizzle's tx fails-and-rolls-back
 *   the journal entry too, so on retry the migration is re-attempted).
 *   Test envs that run partial migrations + bypass the rollback (manual
 *   ad-hoc fixups) end up in this drift state.
 *
 * Usage:
 *   pnpm tsx scripts/repair-enum-drift.ts
 *
 * Idempotent: re-running this script after a successful run is a
 * no-op. Idempotency is guaranteed by TWO mechanisms:
 *   1. Newer migrations declare `ALTER TYPE … ADD VALUE IF NOT EXISTS`
 *      directly — Postgres skips the value when already present.
 *   2. Older migrations wrap the bare `ALTER TYPE … ADD VALUE` in a
 *      `DO $$ BEGIN IF NOT EXISTS (SELECT … FROM pg_enum) THEN …` block.
 *      The regex below extracts the inner bare statement (without the
 *      DO-block guard) — re-applying it raises Postgres `42710
 *      duplicate_object`, which the catch block treats as expected.
 * Either way, replay is safe.
 *
 * This script intentionally does NOT touch the drizzle journal — it only
 * applies the missing enum values. The journal stays consistent with
 * what `pnpm db:migrate` reported.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

process.loadEnvFile?.('.env.local');

const url =
  process.env['DATABASE_URL_UNPOOLED'] ??
  process.env['POSTGRES_URL_NON_POOLING'] ??
  process.env['DATABASE_URL'];

if (!url) {
  console.error(
    'repair-enum-drift: DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.',
  );
  process.exit(1);
}

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations');

// `ALTER TYPE "name" ADD VALUE [IF NOT EXISTS] 'literal' [BEFORE|AFTER 'other'];`
// Whitespace-tolerant. Captures the entire statement up to the trailing
// semicolon so it can be replayed verbatim.
const ALTER_TYPE_RE =
  /ALTER\s+TYPE\s+"?[a-zA-Z_][a-zA-Z0-9_]*"?\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'[^']+'(?:\s+(?:BEFORE|AFTER)\s+'[^']+')?\s*;/gi;

interface AlterTypeStatement {
  readonly file: string;
  readonly sql: string;
}

function collectAlterTypeStatements(): ReadonlyArray<AlterTypeStatement> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const collected: AlterTypeStatement[] = [];
  for (const name of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, name), 'utf-8');
    const matches = text.match(ALTER_TYPE_RE);
    if (matches === null) continue;
    for (const sql of matches) {
      // Normalise whitespace so duplicates across files are spotted; we
      // still apply each one independently because IF NOT EXISTS makes
      // this safe.
      collected.push({ file: name, sql: sql.trim() });
    }
  }
  return collected;
}

async function main(): Promise<void> {
  const statements = collectAlterTypeStatements();
  console.log(
    `repair-enum-drift: found ${statements.length} ALTER TYPE statements across ${
      new Set(statements.map((s) => s.file)).size
    } migration files`,
  );
  if (statements.length === 0) {
    console.log('repair-enum-drift: nothing to do.');
    return;
  }

  // postgres-js with `max: 1` + manual `unsafe()` runs each call as its
  // own implicit-autocommit statement (no BEGIN/COMMIT wrap), which is
  // exactly what `ALTER TYPE ADD VALUE` requires.
  const client = postgres(url!, {
    max: 1,
    ssl: 'require',
    connection: { statement_timeout: 30_000 } as Record<string, string | number>,
  });

  let applied = 0;
  let skipped = 0;
  try {
    for (const { file, sql } of statements) {
      try {
        await client.unsafe(sql);
        applied++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // `IF NOT EXISTS` should make every replay a no-op, but if the
        // file used the older non-idempotent form we treat 42710
        // (duplicate_object) as expected.
        if (msg.includes('already exists') || msg.includes('42710')) {
          skipped++;
        } else {
          console.error(
            `repair-enum-drift: FAILED on ${file}: ${msg}\n  sql: ${sql}`,
          );
          throw e;
        }
      }
    }
    console.log(
      `repair-enum-drift: ✓ applied ${applied} / skipped ${skipped} (already present)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('repair-enum-drift: crashed:', e);
  process.exit(1);
});
