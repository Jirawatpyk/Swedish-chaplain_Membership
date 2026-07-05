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
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import {
  extractAlterTypeAddValueStatements,
  findMissingEnumValues,
  formatMissingEnumValuesError,
} from './lib/enum-migration-guard';

// Local convenience: load `.env.local` if present (covers direct `tsx`
// invocations alongside the `--env-file=.env.local` flag in `pnpm db:migrate`).
// On Vercel / CI there is no `.env.local` — env comes from the injected
// `process.env` — so a missing file is NOT an error (`?.` only guards an
// undefined function, not ENOENT; the try/catch covers the missing file).
try {
  process.loadEnvFile?.('.env.local');
} catch {
  // .env.local absent (Vercel build / CI) — use the ambient process.env.
}

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

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations');

type Sql = ReturnType<typeof postgres>;

/**
 * True when a driver error means the enum value is already present (`IF NOT
 * EXISTS` no-op, or the older bare form re-applied → 42710 duplicate_object).
 */
function isAlreadyExists(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === '42710' || message.includes('already exists');
}

/**
 * True when a driver error means the target enum TYPE does not exist yet. On a
 * fresh database the type is created by a later migration, and the transactional
 * migrate() adds the value safely in the same transaction that creates the type
 * (PostgreSQL allows using a new value of a same-transaction-created enum). So
 * we simply skip the autocommit pre-pass for a not-yet-created type.
 */
function isUndefinedType(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === '42704' || message.includes('does not exist');
}

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

async function main(): Promise<void> {
  const client = postgres(url!, {
    max: 1,
    ssl: 'require',
    connection: { statement_timeout: 30_000 } as Record<string, string | number>,
  });
  const db = drizzle(client);

  let failure: string | null = null;
  try {
    // Phase 1 — commit enum-adds in their own transaction (see header).
    await applyEnumAddsAutocommit(client);
    // Phase 2 — normal transactional migrate (journal / __drizzle_migrations).
    await migrate(db, { migrationsFolder: './drizzle/migrations' });
    console.log('✓ Migrations applied');
    // Phase 3 — fail loudly if a code-required enum value did not land.
    const missing = await findMissingRequiredEnums(client);
    if (missing.length > 0) {
      failure = formatMissingEnumValuesError(missing);
    }
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
