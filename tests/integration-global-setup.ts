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
 *
 * Then deletes the rows of leaked `test-*` TENANTS (135): platform crons
 * enumerate every tenant, so each leaked one slows them and every test that
 * drives one (168 on 2026-10-27 timed out the redact crons under pre-push).
 * Same age filter — a tenant whose newest row is younger belongs to a run in
 * progress. Unlike the operator script it never disables a trigger (that lock
 * would stall other sessions on the shared branch), skips tenants it cannot
 * fully drain (the refund ↔ credit-note cycle, a delete-guarded table), and
 * runs under a statement and lock timeout. Hygiene only: a failure is logged
 * and the run goes on.
 */
import postgres from 'postgres';
import { assertDbHostNotBlocklisted } from './helpers/db-host-guard';
import { AUTOMATIC_SWEEP_OPTIONS, sweepLeakedTestTenants } from '../scripts/lib/leaked-test-tenants';

const STALE_HOURS = 6;

export default async function disableStaleLeakedTestStaff(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL;
  if (!dbUrl) return; // the per-file guard reports the missing URL
  assertDbHostNotBlocklisted(dbUrl, process.env.TEST_DB_HOST_BLOCKLIST, 'integration-global-setup');
  // Bounded: hygiene must never stall the run behind a lock or a slow scan.
  const sql = postgres(dbUrl, {
    ssl: 'require',
    max: 1,
    connection: { statement_timeout: 60_000, lock_timeout: 5_000 },
  });
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

    const started = Date.now();
    try {
      const r = await sweepLeakedTestTenants(sql, AUTOMATIC_SWEEP_OPTIONS);
      const ms = Date.now() - started;
      // Quiet when there was nothing to do and it was quick; the skipped
      // (undrainable) count rides along whenever it does speak.
      if (r.eligible.length > 0 || ms > 5_000) {
        const notDrainable = r.stuck.length + r.skippedStuck.length;
        console.warn(
          `[integration-global-setup] swept ${r.fullyCleaned}/${r.eligible.length} leaked test tenant(s) ` +
            `older than ${AUTOMATIC_SWEEP_OPTIONS.maxAgeHours} h in ${ms} ms` +
            (r.skippedBudget.length > 0 ? `; ${r.skippedBudget.length} deferred to the next run (time budget)` : '') +
            (notDrainable > 0
              ? `; ${notDrainable} not fully drainable here (run scripts/cleanup-leaked-test-tenants.ts)`
              : ''),
        );
      }
    } catch (e) {
      // SQLSTATE, not the message: an FK error's DETAIL carries key values.
      const code =
        typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
      console.warn(
        `[integration-global-setup] leaked test-tenant sweep failed ` +
          `(${e instanceof Error ? e.constructor.name : 'unknown'}${code ? ` ${code}` : ''}); continuing`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
