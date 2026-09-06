/**
 * Wave-4 S20 — shared owner-role Postgres client for e2e seed helpers.
 *
 * The `postgres(dbUrl, { ssl: 'require', max: 1 })` open-or-skip block was
 * copy-pasted across seed helpers; this is the single canonical copy.
 * Connects via `DATABASE_URL` (`neondb_owner`, BYPASSRLS) — e2e seeds are
 * deliberately tenant-unscoped fixture writers, same pattern as
 * `scripts/seed-*`.
 *
 * Returns `null` (with a labelled warn) when `DATABASE_URL` is missing so
 * callers can no-op/skip gracefully on machines without DB credentials.
 * Callers MUST `await client.end()` in a `finally`.
 */
import postgres from 'postgres';
import { assertDbHostNotBlocklisted } from '../../helpers/db-host-guard';

export interface SeedClient {
  sql: ReturnType<typeof postgres>;
  end: () => Promise<void>;
}

export function openSeedClient(label: string): SeedClient | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn(`[${label}] skipped — DATABASE_URL missing`);
    return null;
  }
  // Production-safety guard — the shared fail-closed helper (108 T041 L6 +
  // PR-D LOW-5 / MEDIUM-12): a listed host OR an empty list refuses.
  assertDbHostNotBlocklisted(dbUrl, process.env.TEST_DB_HOST_BLOCKLIST, label);
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  return { sql, end: () => sql.end() };
}
