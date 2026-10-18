/**
 * Fresh-DB migration mode for `scripts/run-migrations.ts` (spec 123 slice 2).
 *
 * WHY: drizzle-orm's `PgDialect.migrate` applies every pending migration inside
 * ONE transaction. On an empty database that is the whole 300-file chain, and
 * PostgreSQL refuses to USE an enum value added earlier in the same transaction
 * (55P04 "unsafe use of new value") — 0020 adds `invoice_overdue_detected`,
 * 0021 builds a partial index on it. The run-migrations enum pre-pass cannot
 * help there: on an empty DB none of the types exist yet, so it skips every
 * statement. Nothing had ever migrated from zero before (dev, CI and preview
 * all branch from prod), which made this a latent disaster-recovery bug too.
 *
 * WHAT: when `drizzle.__drizzle_migrations` is missing or empty, apply the
 * journal one entry per transaction instead. Each file first commits its OWN
 * `ALTER TYPE … ADD VALUE` statements in autocommit (the pre-pass, scoped to
 * that file, run once the earlier files have created the types) — 0308 adds
 * `broadcast_status` values and builds a partial index on one of them in the
 * same file, which is 55P04 inside one transaction. Then the file's statements
 * and its `(hash, created_at = folderMillis)` row commit together.
 *
 * Applied-or-not is decided by HASH, never by `created_at`: the journal has two
 * non-increasing `when` pairs (0023→0024, 0029→0030), so a created_at
 * comparison would silently skip files. Hashes are sha256 of the file bytes on
 * this checkout (CRLF on Windows ≠ LF on Linux), so they are only ever compared
 * within one run's machine, never across checkouts.
 *
 * NOT RESUMED: a fresh run that fails at file k leaves k−1 rows, so the next
 * run takes the NORMAL path (pre-pass + one drizzle transaction). A mid-fresh
 * failure is a genuine breakage; read the FIRST attempt's error.
 *
 * Kept free of postgres-js / drizzle imports so it unit-tests against a fake.
 */
import { extractAlterTypeAddValueStatements } from './enum-migration-guard';

export interface MigrationSqlRunner {
  unsafe(query: string, params?: readonly unknown[]): Promise<ReadonlyArray<Record<string, unknown>>>;
}

export interface MigrationSqlClient extends MigrationSqlRunner {
  /** Runs `fn` in one transaction. Inside `fn`, touch only `tx` — the outer
   * client has a single connection (`max: 1`), which the transaction holds. */
  begin<T>(fn: (tx: MigrationSqlRunner) => Promise<T>): Promise<T>;
}

export type MigrationMode = 'fresh' | 'normal';

/** One entry as `readMigrationFiles` (drizzle-orm/migrator) returns it. */
export interface JournalMigration {
  readonly sql: readonly string[];
  readonly folderMillis: number;
  readonly hash: string;
}

export interface TaggedMigration extends JournalMigration {
  readonly tag: string;
}

export interface FreshMigrationResult {
  readonly applied: number;
  readonly skipped: number;
  readonly elapsedMs: number;
}

const MIGRATIONS_TABLE = '"drizzle"."__drizzle_migrations"';

/**
 * True when a driver error means the enum value is already present (`IF NOT
 * EXISTS` no-op, or the older bare form re-applied → 42710 duplicate_object).
 */
export function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === '42710' || message.includes('already exists');
}

/**
 * True when a driver error means the target enum TYPE does not exist yet — it
 * is created later (or by the very file that adds the value, and PostgreSQL
 * allows using a new value of an enum created in the same transaction).
 */
export function isUndefinedType(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === '42704' || message.includes('does not exist');
}

/**
 * `fresh` when the migrations table is missing or has zero rows, else `normal`.
 * `to_regclass` first: counting a table that does not exist raises 42P01.
 */
export async function decideMigrationMode(client: MigrationSqlClient): Promise<MigrationMode> {
  const [reg] = await client.unsafe(`select to_regclass('drizzle.__drizzle_migrations') as t`);
  if (reg?.t === null || reg?.t === undefined) return 'fresh';
  const [count] = await client.unsafe(`select count(*)::int as n from ${MIGRATIONS_TABLE}`);
  return Number(count?.n ?? 0) === 0 ? 'fresh' : 'normal';
}

/**
 * `readMigrationFiles` drops the tag; zip it back from the journal (same order —
 * it iterates `journal.entries`) so a failure can name the file.
 */
export function attachJournalTags(
  migrations: readonly JournalMigration[],
  entries: ReadonlyArray<{ readonly tag: string }>,
): TaggedMigration[] {
  if (migrations.length !== entries.length) {
    throw new Error(
      `migrate-fresh: ${migrations.length} migrations but ${entries.length} journal entries`,
    );
  }
  return migrations.map((migration, i) => ({ ...migration, tag: entries[i]!.tag }));
}

/**
 * Apply every not-yet-recorded entry, in journal order, one transaction each.
 * Throws on the first failure, naming the file; earlier files stay committed.
 *
 * Afterwards a normal drizzle `migrate()` sees the DB as up to date: it reads
 * `order by created_at desc limit 1` and applies only entries whose
 * `folderMillis` is greater. Every entry's row is written here with its own
 * `folderMillis`, so the max row equals the journal's max `when` and no entry
 * exceeds it (the real journal ends on its max — unit-tested).
 */
export async function applyFreshMigrations(
  client: MigrationSqlClient,
  migrations: readonly TaggedMigration[],
  now: () => number = Date.now,
): Promise<FreshMigrationResult> {
  const started = now();
  // drizzle's own DDL (pg-core/dialect.js `migrate`), so its later migrate()
  // finds exactly the table it would have created.
  await client.unsafe('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.unsafe(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
				id SERIAL PRIMARY KEY,
				hash text NOT NULL,
				created_at bigint
			)`);

  const recorded = new Set(
    (await client.unsafe(`select hash from ${MIGRATIONS_TABLE}`)).map((row) => String(row.hash)),
  );

  let applied = 0;
  let skipped = 0;
  for (const [index, migration] of migrations.entries()) {
    if (recorded.has(migration.hash)) {
      skipped += 1;
      continue;
    }
    try {
      for (const stmt of extractAlterTypeAddValueStatements(migration.sql.join('\n'))) {
        try {
          await client.unsafe(stmt);
        } catch (error) {
          if (!isAlreadyExists(error) && !isUndefinedType(error)) throw error;
        }
      }
      await client.begin(async (tx) => {
        for (const stmt of migration.sql) {
          await tx.unsafe(stmt);
        }
        await tx.unsafe(`insert into ${MIGRATIONS_TABLE} ("hash", "created_at") values ($1, $2)`, [
          migration.hash,
          migration.folderMillis,
        ]);
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `fresh migrate: FAILED on ${migration.tag} (file ${index + 1} of ${migrations.length}; ` +
          `${applied} committed before it): ${detail}`,
        { cause: error },
      );
    }
    recorded.add(migration.hash);
    applied += 1;
  }
  return { applied, skipped, elapsedMs: now() - started };
}
