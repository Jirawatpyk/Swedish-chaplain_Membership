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
  // Production-safety guard (108 T041 security review, L6). Every caller of
  // this client is a BYPASSRLS fixture writer that DELETEs by pattern; the
  // integration suite already refuses a blocklisted host
  // (`tests/integration-setup.ts`), and the e2e seeds had no equivalent.
  // Fail-closed: a matching fragment throws, it never degrades to a warning.
  const blocklist = (process.env.TEST_DB_HOST_BLOCKLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // 108 PR-D review cycle 11 (security LOW-5): an EMPTY blocklist is not "no
  // production host to worry about" — it is a guard with nothing to check,
  // which on a machine whose `.env.local` lacks the key made every seed
  // writer prod-reachable. Refuse to open until the operator names the
  // fragments (see `.env.example`).
  if (blocklist.length === 0) {
    throw new Error(
      `[${label}] refusing to open a seed client: TEST_DB_HOST_BLOCKLIST is unset or empty. ` +
        `Set it to the production Neon host fragment(s) (comma-separated) in .env.local — ` +
        `the guard fails closed rather than trusting that DATABASE_URL is not prod.`,
    );
  }
  const blocked = blocklist.find((needle) => dbUrl.includes(needle));
  if (blocked) {
    throw new Error(
      `[${label}] refusing to open a seed client against a blocklisted database ` +
        `(host matched "${blocked}" from TEST_DB_HOST_BLOCKLIST). Point DATABASE_URL ` +
        `at a dev/test Neon branch — never production.`,
    );
  }
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  return { sql, end: () => sql.end() };
}
