/**
 * Apply pending Drizzle migrations to the configured database (T025).
 *
 * Usage: `pnpm db:migrate`
 *
 * The env comes from the caller only: `pnpm db:migrate` passes
 * `--env-file=.env.local`, the prod script passes the prod file, and Vercel /
 * CI inject `process.env`. This script loads no env file of its own: a second
 * load of `.env.local` used to fill any variable the prod file lacks (e.g.
 * DATABASE_URL_UNPOOLED, read first) from DEV, the defect #588 fixed in
 * verify-schema.ts. A direct `tsx` run must pass `--env-file` itself. Uses the
 * *unpooled* connection because pooled Neon connections can interfere with
 * schema-changing statements (and with the session advisory lock).
 *
 * Migrations live in `drizzle/migrations/`. The Drizzle journal
 * (`drizzle/migrations/meta/_journal.json`) tracks which ones have been
 * applied — re-running this command is idempotent.
 *
 * ── ENUM-ADD AUTOCOMMIT PRE-PASS + POST-MIGRATE ASSERTION (prod fix) ──────────
 *   The drizzle-orm postgres-js migrator wraps the ENTIRE pending batch in ONE
 *   transaction (`PgDialect.migrate` → `session.transaction(...)`). PostgreSQL
 *   will not reliably persist / safely allow use of a value added by
 *   `ALTER TYPE … ADD VALUE` on a *pre-existing* enum type within that same
 *   transaction. Confirmed on prod 2026-07-04: migration 0230's enum-adds
 *   (`document_type += 'bill','receipt_105'`, `audit_event_type +=
 *   'tax_receipt_issued'`) were recorded as applied but never landed, 500'ing
 *   the 088 new-flow issue path.
 *
 *   Phase 1 below applies every `ALTER TYPE … ADD VALUE` in AUTOCOMMIT *before*
 *   the transactional migrate() so each value commits in its own prior
 *   transaction (idempotent via `IF NOT EXISTS`; the journal / __drizzle_migrations
 *   bookkeeping is left entirely to drizzle — Phase 1 never touches it).
 *   Phase 3 then asserts the code-required values actually exist and exits
 *   non-zero if not, so a half-applied enum can never silently ship again.
 *   See scripts/lib/enum-migration-guard.ts for the full rationale.
 *
 * ── FRESH-DB MODE (spec 123 slice 2) ──────────────────────────────────────────
 *   When `drizzle.__drizzle_migrations` is missing or empty, Phases 1–2 are
 *   replaced by one transaction per journal entry (scripts/lib/migrate-fresh.ts):
 *   from zero, drizzle's single transaction hits 55P04 at 0021 and the global
 *   pre-pass is inert (no type exists yet). Any DB with at least one recorded
 *   migration takes the unchanged path above, so a dev/prod deploy stays
 *   all-or-nothing. A fresh run that stops part-way leaves a marker table, so
 *   the retry resumes in fresh mode. Phase 3 (required enums) and Phase 4
 *   (every journal entry recorded) run after either mode, all under one
 *   session advisory lock.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {
  extractAlterTypeAddValueStatements,
  findMissingEnumValues,
  formatMissingEnumValuesError,
} from './lib/enum-migration-guard';
import {
  applyFreshMigrations,
  attachJournalTags,
  decideMigrationMode,
  findUnrecordedMigrations,
  isAlreadyExists,
  isPooledConnection,
  isUndefinedType,
  migrationTargetHost,
  withMigrationLock,
  type MigrationSqlClient,
  type MigrationSqlRunner,
  type TaggedMigration,
} from './lib/migrate-fresh';

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

// The host only, never the URL: it names which branch is migrated.
const target = migrationTargetHost(url);
if (!target.ok) {
  console.error(`scripts/run-migrations.ts: ${target.message}`);
  process.exit(1);
}
console.log(`Target host: ${target.host}`);

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations');

type Sql = ReturnType<typeof postgres>;

/**
 * Phase 1 — apply every `ALTER TYPE … ADD VALUE` found across the migration
 * files in AUTOCOMMIT (postgres-js `max: 1` + `unsafe()` runs each call as its
 * own implicit transaction, exactly what `ALTER TYPE ADD VALUE` requires).
 * Idempotent: already-present values and not-yet-created types are skipped.
 */
async function applyEnumAddsAutocommit(client: Sql): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const statements: ReadonlyArray<{ readonly file: string; readonly sql: string }> = files.flatMap(
    (file) =>
      extractAlterTypeAddValueStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8')).map(
        (sql) => ({ file, sql }),
      ),
  );

  if (statements.length === 0) {
    return;
  }

  let applied = 0;
  let skipped = 0;
  for (const { file, sql } of statements) {
    try {
      await client.unsafe(sql);
      applied += 1;
    } catch (error) {
      if (isAlreadyExists(error) || isUndefinedType(error)) {
        skipped += 1;
        continue;
      }
      console.error(
        `enum pre-pass: FAILED on ${file}: ${
          error instanceof Error ? error.message : String(error)
        }\n  sql: ${sql}`,
      );
      throw error;
    }
  }
  console.log(
    `✓ Enum pre-pass: applied ${applied}, skipped ${skipped} (already present / type not yet created)`,
  );
}

/**
 * Phase 3 — read the enum labels actually present in the database and return the
 * required values that are missing. Pure comparison lives in
 * enum-migration-guard.ts; this only performs the catalogue read.
 */
async function findMissingRequiredEnums(client: Sql) {
  // Read every public enum label and compare in JS (findMissingEnumValues only
  // inspects the required types). Avoids a `name = text[]` operator-resolution
  // hazard from parameterising the type-name filter; pg_enum is tiny.
  const rows = await client<Array<{ typname: string; enumlabel: string }>>`
    select t.typname as typname, e.enumlabel as enumlabel
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
  `;

  const present = new Map<string, Set<string>>();
  for (const { typname, enumlabel } of rows) {
    const set = present.get(typname) ?? new Set<string>();
    set.add(enumlabel);
    present.set(typname, set);
  }
  return findMissingEnumValues(present);
}

/**
 * Narrow the postgres-js client to the port scripts/lib/migrate-fresh.ts uses.
 * `unsafe(q)` with no params runs on the simple protocol, exactly as drizzle's
 * own migrate() executes each statement.
 */
function asMigrationClient(client: Sql): MigrationSqlClient {
  const runner = (sql: Sql | postgres.TransactionSql): MigrationSqlRunner => ({
    unsafe: async (query, params) =>
      params === undefined
        ? await sql.unsafe(query)
        : await sql.unsafe(query, params as postgres.ParameterOrJSON<never>[]),
  });
  return {
    ...runner(client),
    begin: async <T>(fn: (tx: MigrationSqlRunner) => Promise<T>): Promise<T> =>
      (await client.begin((tx) => fn(runner(tx)))) as T,
  };
}

/** Every journal entry with its tag, in journal order. */
function journalMigrations(): TaggedMigration[] {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf-8'),
  ) as { entries: ReadonlyArray<{ tag: string }> };
  return attachJournalTags(
    readMigrationFiles({ migrationsFolder: './drizzle/migrations' }),
    journal.entries,
  );
}

/** Fresh mode: apply the whole journal, one transaction per file (resumable). */
async function applyFreshFromZero(client: Sql, migrations: readonly TaggedMigration[]): Promise<void> {
  const { applied, skipped, elapsedMs } = await applyFreshMigrations(
    asMigrationClient(client),
    migrations,
  );
  console.log(
    `✓ Fresh-DB migrate: applied ${applied}, skipped ${skipped} (hash already recorded) in ${(
      elapsedMs / 1000
    ).toFixed(1)} s`,
  );
}

async function main(): Promise<void> {
  const client = postgres(url!, {
    max: 1,
    ssl: 'require',
    connection: { statement_timeout: 30_000 } as Record<string, string | number>,
  });
  const db = drizzle(client);

  let failure: string | null = null;
  const port = asMigrationClient(client);
  try {
    // One session advisory lock around the mode decision, the apply and the
    // checks, in both modes (scripts/lib/migrate-fresh.ts § withMigrationLock).
    await withMigrationLock(port, async () => {
      const migrations = journalMigrations();
      const mode = await decideMigrationMode(port);
      if (mode === 'fresh') {
        // Empty database, or a fresh run that stopped part-way (the marker):
        // one transaction per journal entry — see scripts/lib/migrate-fresh.ts.
        // drizzle's single-transaction migrate() hits 55P04 at 0021 here, and
        // the global enum pre-pass is inert because no type exists yet.
        await applyFreshFromZero(client, migrations);
      } else {
        // Phase 1 — commit enum-adds in their own transaction (see header).
        // (Phase 0, the 016 D7 promotion gate, was deleted in PR 5 with the
        // cutover machinery it protected.)
        await applyEnumAddsAutocommit(client);
        // Phase 2 — normal transactional migrate (journal / __drizzle_migrations).
        await migrate(db, { migrationsFolder: './drizzle/migrations' });
        console.log('✓ Migrations applied');
      }
      // Phase 3 — fail loudly if a code-required enum value did not land.
      const missing = await findMissingRequiredEnums(client);
      if (missing.length > 0) {
        failure = formatMissingEnumValuesError(missing);
        return;
      }
      // Phase 4 — every journal entry must be recorded (by hash or by
      // created_at). drizzle's normal path skips an entry whose `when` is
      // older than the newest applied one, and says nothing. No allow-list:
      // 0317 recorded the four legacy F8 entries (0110-0113) on prod.
      const unrecorded = await findUnrecordedMigrations(port, migrations);
      if (unrecorded.length > 0) {
        failure =
          `${unrecorded.length} journal entr${unrecorded.length === 1 ? 'y is' : 'ies are'} not recorded in ` +
          `drizzle.__drizzle_migrations (neither its hash nor its created_at = when):\n` +
          unrecorded.map((m) => `  - ${m.tag} (when ${m.folderMillis})`).join('\n');
      }
    }, { pooled: isPooledConnection(url!) });
  } catch (error) {
    failure = `Migration failed: ${
      error instanceof Error ? (error.stack ?? error.message) : String(error)
    }`;
  } finally {
    await client.end();
  }

  if (failure !== null) {
    console.error(`✗ ${failure}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('run-migrations: crashed:', error);
  process.exit(1);
});
