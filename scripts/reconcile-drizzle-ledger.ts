/**
 * Reconcile the Drizzle migration ledger (`drizzle.__drizzle_migrations`) with
 * the journal (`drizzle/migrations/meta/_journal.json`).
 *
 * WHY THIS EXISTS: hand-written migrations (e.g. F7.1a 0177–0179) were applied
 * to the database SCHEMA but their rows were never recorded in the ledger.
 *
 * `drizzle-kit migrate` uses a TIMESTAMP-THRESHOLD model (verified against
 * drizzle-orm/pg-core): it reads the single ledger row with `max(created_at)`
 * and applies every journal entry whose `when` (folderMillis) is GREATER than
 * that, in one batch. When the recent F7.1a entries were never ledgered, the
 * threshold sits below their `when`, so migrate re-applies 0177,0178,0179,… —
 * and fails on the first non-idempotent statement (0179's `ALTER TABLE ... ADD
 * CONSTRAINT`, no IF NOT EXISTS), aborting BEFORE any genuinely-new migration
 * (0180+) can commit. Net effect: migrate makes no forward progress.
 *
 * This script advances the threshold by inserting ledger rows for the already-
 * schema-applied entries (idx in [ledgerCount .. through], a contiguous prefix
 * of the unledgered tail) so `max(created_at)` rises past them and
 * `drizzle-kit migrate` only runs the truly-new migrations (when > through.when).
 * The inserts run in ONE transaction so a crash mid-backfill cannot leave a
 * partial threshold that re-breaks migrate.
 *
 * The ledger row is (hash, created_at) = (sha256(<raw .sql bytes>),
 * journal.when) — the exact shape Drizzle itself writes.
 *
 * USAGE:
 *   # dry-run (read-only) — show the unledgered tail + what would be backfilled:
 *   node --env-file=.env.local --import tsx scripts/reconcile-drizzle-ledger.ts
 *
 *   # backfill schema-applied entries up to idx N (the boundary BELOW the
 *   # first genuinely-new migration). Entries idx > N are left for migrate:
 *   node --env-file=.env.local --import tsx scripts/reconcile-drizzle-ledger.ts --through 179
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle', 'migrations');

function drizzleHash(tag: string): string {
  const content = readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`)).toString();
  return createHash('sha256').update(content).digest('hex');
}

function parseThroughArg(): number | null {
  const i = process.argv.indexOf('--through');
  if (i === -1) return null;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n)) throw new Error('--through requires an integer idx');
  return n;
}

async function main(): Promise<void> {
  const journal: { entries: JournalEntry[] } = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json')).toString(),
  );
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const through = parseThroughArg();

  const countRows = await db.execute(
    sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
  );
  const ledgerCount = Number(
    (countRows as unknown as Array<{ n: number }>)[0]?.n ?? 0,
  );

  console.log(
    `ledger rows: ${ledgerCount} | journal entries: ${entries.length}`,
  );
  // Drizzle's ordinal model: entries [0 .. ledgerCount-1] are applied; the
  // rest are pending and would be re-run together on the next migrate.
  const pending = entries.slice(ledgerCount);
  console.log(
    `pending (would be re-run by migrate): ${pending.map((p) => p.tag).join(', ') || '(none)'}`,
  );

  if (through === null) {
    console.log(
      '\nDry-run only. Re-run with `--through <idx>` to advance the ledger ' +
        'past the already-schema-applied entries.',
    );
    process.exit(0);
  }

  // Backfill the contiguous schema-applied window [ledgerCount .. through].
  const toBackfill = pending.filter((e) => e.idx <= through);
  const leftForMigrate = pending.filter((e) => e.idx > through);
  if (toBackfill.length === 0) {
    console.log(`Nothing to backfill at or below idx ${through}.`);
    process.exit(0);
  }
  // Safety: only allow a CONTIGUOUS prefix of the pending set (no gaps), since
  // the ordinal model requires the ledger count to advance one-for-one.
  const expectedIdx = entries.slice(ledgerCount, ledgerCount + toBackfill.length);
  const contiguous = toBackfill.every((e, i) => e.idx === expectedIdx[i]?.idx);
  if (!contiguous) {
    console.error('ABORT: backfill window is not a contiguous prefix of pending.');
    process.exit(2);
  }
  // drizzle-kit migrate keys on MAX(created_at) (timestamp threshold), NOT row
  // count. So the backfilled `when` values must be strictly increasing AND
  // every entry left for migrate must have a LARGER `when` — otherwise raising
  // the threshold to max(backfilled.when) would make migrate skip a pending
  // migration whose `when` sits below it, leaving a silent schema gap.
  const wins = toBackfill.map((e) => e.when);
  const monotonic = wins.every((w, i) => i === 0 || w > (wins[i - 1] ?? -Infinity));
  const maxBackfill = Math.max(...wins);
  const allLeftAbove = leftForMigrate.every((e) => e.when > maxBackfill);
  if (!monotonic || !allLeftAbove) {
    console.error(
      'ABORT: journal `when` values are not strictly increasing across the ' +
        'backfill/remaining boundary — backfilling would corrupt the ' +
        'MAX(created_at) threshold and could silently skip a pending migration.',
    );
    process.exit(2);
  }

  // One transaction: a crash mid-backfill must not leave a partial threshold
  // (e.g. 0177 applied but not 0178/0179) — that would make the next migrate
  // re-run the non-idempotent 0179 and fail again.
  await db.transaction(async (tx) => {
    for (const e of toBackfill) {
      await tx.execute(
        sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
            VALUES (${drizzleHash(e.tag)}, ${e.when})`,
      );
      console.log(`backfilled ledger: ${e.tag} (idx ${e.idx})`);
    }
  });
  console.log(
    `\nDone. Ledger now ${ledgerCount + toBackfill.length} rows. ` +
      `Run \`pnpm drizzle-kit migrate\` to apply: ${leftForMigrate.map((m) => m.tag).join(', ') || '(none)'}`,
  );
  process.exit(0);
}

void main();
