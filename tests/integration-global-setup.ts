/**
 * Integration globalSetup — runs once per `pnpm test:integration`, before any file.
 *
 * Disables STAFF test users that earlier runs leaked: rows a suite inserted
 * and never removed, because it skipped `deleteTestUser`, inserted with
 * `db.insert(users)` itself, or its worker was killed before the per-file
 * sweep in tests/integration-setup.ts ran. Each leaked ACTIVE staff user is
 * one more outbox row in every per-reviewer fan-out on the shared dev branch
 * (1,327 leaked 2026-10-20..24; a change-request submit took 60–83 s).
 *
 * Scope, so concurrent runs and real accounts are never touched:
 *   - only test domains (`@swecham.test`, `@example.com`, `@wipe.test`);
 *   - never the e2e personas (`e2e-…`);
 *   - only rows older than STALE_HOURS (a concurrent run's users are younger);
 *   - only non-member roles (the fan-out reads staff);
 *   - disabled, not deleted (21 FKs reference users).
 * Refuses a blocklisted (prod) host, like the per-file guard.
 */
import postgres from 'postgres';
import { assertDbHostNotBlocklisted } from './helpers/db-host-guard';

const STALE_HOURS = 6;

export default async function disableStaleLeakedTestStaff(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL;
  if (!dbUrl) return; // the per-file guard reports the missing URL
  assertDbHostNotBlocklisted(dbUrl, process.env.TEST_DB_HOST_BLOCKLIST, 'integration-global-setup');
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    const rows = await sql`
      UPDATE users SET status = 'disabled'
      WHERE status = 'active'
        AND role <> 'member'
        AND created_at < now() - make_interval(hours => ${STALE_HOURS})
        AND email ~ '@(swecham\\.test|example\\.com|wipe\\.test)$'
        AND email NOT LIKE 'e2e-%'
      RETURNING id
    `;
    if (rows.length > 0) {
      console.warn(`[integration-global-setup] disabled ${rows.length} leaked test staff user(s) older than ${STALE_HOURS} h`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
