/**
 * One-shot reconciliation: sync `drizzle.__drizzle_migrations` to match
 * the journal at `drizzle/migrations/meta/_journal.json`.
 *
 * Why this exists:
 *   The team has historically applied some migrations via ad-hoc
 *   `dev-apply-migration.ts` runs (which BYPASS drizzle-kit's
 *   bookkeeping table). This left `__drizzle_migrations` out of sync
 *   with the journal — drizzle-kit then thinks those migrations are
 *   un-applied and tries to re-run them on next `pnpm db:migrate`,
 *   failing for any non-idempotent SQL.
 *
 * What this script does:
 *   - Reads the journal in order.
 *   - For each entry, computes `sha256(rawFileContent)` — the EXACT
 *     algorithm drizzle-kit uses (verified against
 *     `node_modules/drizzle-orm/migrator.js`).
 *   - For each missing hash, INSERTs a bookkeeping record WITHOUT
 *     re-running the SQL (the migration is assumed to already be in
 *     the DB — proven by inspection of the schema state).
 *
 * After this runs, `pnpm db:migrate` becomes the canonical command for
 * future migrations.
 *
 * Usage:
 *   pnpm db:sync-bookkeeping              # uses .env.local
 *   pnpm db:sync-bookkeeping:prod         # uses .env.production
 *
 * Idempotent: re-running is a no-op when bookkeeping is already in sync.
 *
 * SAFETY: this script ONLY writes to the bookkeeping table. It NEVER
 * runs migration SQL. If a migration in the journal has NOT actually
 * been applied to the DB, this script will record it as applied
 * (incorrect state). Verify schema integrity via `pnpm db:verify`
 * BEFORE running this script in any new environment.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import postgres from 'postgres';

const MIGRATIONS_DIR = './drizzle/migrations';
const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`;

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

/** Drizzle-kit's exact hash algorithm — sha256 of raw file content. */
function drizzleHash(rawSql: string): string {
  return createHash('sha256').update(rawSql).digest('hex');
}

async function main(): Promise<void> {
  const url =
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.DATABASE_URL;
  if (!url) {
    console.error('sync-drizzle-bookkeeping: DATABASE_URL_UNPOOLED (or DATABASE_URL) is required.');
    process.exit(1);
  }

  const journal: Journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'));
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

  const client = postgres(url, {
    max: 1,
    ssl: 'require',
    connection: { statement_timeout: 30_000 } as Record<string, string | number>,
  });

  try {
    await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
    await client`
      CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      )
    `;

    const recorded = await client<{ hash: string }[]>`
      SELECT hash FROM drizzle.__drizzle_migrations
    `;
    const recordedHashes = new Set(recorded.map((r) => r.hash));
    console.log(`Bookkeeping has ${recordedHashes.size} hash(es) recorded.`);
    console.log(`Journal has ${entries.length} entries.`);

    let inserted = 0;
    let alreadyOk = 0;
    let tamperWarnings = 0;
    // R3 F-15 (2026-04-28): track entries already recorded by a hash
    // that matches the CURRENT file content vs. by a hash that does
    // NOT match. The latter signals a migration .sql file was modified
    // after recording — drift that drizzle-kit would never catch since
    // the recorded hash is treated as source-of-truth. Surfaces a warn
    // (never auto-fixes — operator must investigate via git diff).
    for (const entry of entries) {
      const sqlPath = join(MIGRATIONS_DIR, `${entry.tag}.sql`);
      let raw: string;
      try {
        raw = readFileSync(sqlPath, 'utf8');
      } catch {
        console.warn(`  ⚠ ${entry.tag}: file not found at ${sqlPath} — skipping`);
        continue;
      }
      const hash = drizzleHash(raw);
      if (recordedHashes.has(hash)) {
        alreadyOk += 1;
        continue;
      }
      // Hash does not match. Two sub-cases:
      //   (a) genuinely new migration → INSERT
      //   (b) file modified after recording → warn (and still INSERT
      //       the new hash so future runs settle on it).
      const recordedAny = await client<{ hash: string }[]>`
        SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when}
      `;
      if (recordedAny.length > 0) {
        console.warn(
          `  ⚠ ${entry.tag}: TAMPER DETECTED — file content hash differs from previously-recorded hash. ` +
            `Run \`git diff drizzle/migrations/${entry.tag}.sql\` to investigate. New hash will be recorded.`,
        );
        tamperWarnings += 1;
      }
      await client`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${hash}, ${entry.when})
      `;
      inserted += 1;
      console.log(`  ▸ ${entry.tag} — recorded (idx=${entry.idx})`);
    }
    if (tamperWarnings > 0) {
      console.warn(
        `\n⚠ ${tamperWarnings} tamper warning(s) — review the listed migrations.`,
      );
    }

    console.log(
      `✓ Done — already ok: ${alreadyOk}, newly recorded: ${inserted}`,
    );
    if (inserted > 0) {
      console.log(
        '\nNext: `pnpm db:migrate` is now the canonical command for future migrations.',
      );
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error('sync-drizzle-bookkeeping: crashed:', e);
  process.exit(1);
});
