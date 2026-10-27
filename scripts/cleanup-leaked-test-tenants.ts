/**
 * Delete the rows left behind by throwaway integration-test tenants.
 *
 * WHY THIS KEEPS MATTERING — `createTestTenant('test-swecham')` mints a
 * `test-<prefix>-<uuid8>` slug and the suite calls the closure's `cleanup()` in
 * `afterAll`. Three things leak anyway:
 *
 *   1. `afterAll` never runs (worker crash, low-memory watchdog, Ctrl-C);
 *   2. every call site does `cleanup().catch(() => {})`, so an FK failure —
 *      e.g. the settled-refund ↔ credit-note RESTRICT cycle documented in
 *      `tests/integration/helpers/test-tenant.ts` — is swallowed;
 *   3. the helper's table list goes stale: a feature adds a tenant-scoped
 *      table and nobody adds it to the cleanup (this script found six such
 *      tables on 2026-09-27).
 *
 * WHY IT IS NOT JUST UNTIDY — several crons are PLATFORM crons: they read a
 * tenant list out of a tenant-scoped table and then sweep one tenant per round
 * trip. Every leaked tenant is one more round trip for every such cron and for
 * every test that drives one. Measured on the shared `dev` branch on
 * 2026-09-27: 100 rows in `tenant_invoice_settings`, 3 of them real, and
 * `redact-expired-member-invoices` timed out at 60 s because two sweeps of 99
 * tenants cost ~21 s each (PR #436).
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO DO
 *   - Discovers every tenant-scoped BASE TABLE from `information_schema`, so a
 *     table added after this script was written is still cleaned. Views are
 *     skipped by construction; `audit_log` is skipped because its append-only
 *     trigger blocks DELETE (that pollution is undeletable by design).
 *   - Only touches slugs matching /^test(-|$)/.
 *   - **Age filter.** A tenant is eligible only when the newest row it owns is
 *     older than `CLEANUP_MAX_AGE_HOURS` (default 6). The shared `dev` branch
 *     is used by whoever is running tests right now, and there is no other way
 *     to tell a live fixture from litter.
 *   - Deletes per tenant, in ONE transaction per tenant, draining the table
 *     list in repeated passes with a savepoint around each DELETE: a table
 *     whose turn has not come yet (FK) simply retries on the next pass. No
 *     hand-maintained FK order to go stale, and one stuck tenant cannot abort
 *     the others.
 *   - Commits the partial result for a tenant it cannot finish and reports
 *     which tables are left, rather than rolling the tenant back: the rows are
 *     throwaway either way, and the report is the thing a human needs.
 *
 * The discovery and drain live in `scripts/lib/leaked-test-tenants.ts`, shared
 * with the integration globalSetup, which runs the same sweep automatically
 * (135). Only this operator run may disable a delete-guarded table's trigger.
 *
 * Usage (dry run first — it prints exactly what it would delete):
 *   node --env-file=.env.local --import tsx scripts/cleanup-leaked-test-tenants.ts
 *   CLEANUP_APPLY=true node --env-file=.env.local --import tsx \
 *     scripts/cleanup-leaked-test-tenants.ts
 * (PowerShell: `$env:CLEANUP_APPLY='true'; node …` — the `VAR=x cmd` form is bash.)
 *
 * Env:
 *   CLEANUP_APPLY=true            actually delete (default: dry run)
 *   CLEANUP_MAX_AGE_HOURS=6       only tenants whose newest row is older
 *   CLEANUP_INCLUDE_UNDATABLE     also clean tenants whose tables carry no
 *                                 `created_at` at all (age unknowable)
 *
 * Refuses to run against the endpoint named by `TEST_DB_HOST_BLOCKLIST` — the
 * same guard `tests/integration-setup.ts` uses to keep the suite off prod.
 */
import postgres from 'postgres';
import { sweepLeakedTestTenants } from './lib/leaked-test-tenants';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return v;
}

function assertNotProd(url: string): void {
  const blocklist = requireEnv('TEST_DB_HOST_BLOCKLIST')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const host = new URL(url).host;
  const hit = blocklist.find((b) => host.includes(b));
  if (hit !== undefined) {
    console.error(
      `REFUSING: DATABASE_URL host ${host} matches TEST_DB_HOST_BLOCKLIST entry "${hit}".`,
    );
    console.error('This script deletes rows. It is for the dev branch only.');
    process.exit(1);
  }
  console.log(`host ${host} (not blocklisted)`);
}

async function main(): Promise<void> {
  const url = requireEnv('DATABASE_URL');
  assertNotProd(url);

  const apply = process.env['CLEANUP_APPLY'] === 'true';
  const maxAgeHours = Number(process.env['CLEANUP_MAX_AGE_HOURS'] ?? 6);
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    console.error('CLEANUP_MAX_AGE_HOURS must be a non-negative number');
    process.exit(1);
  }
  const includeUndatable = process.env['CLEANUP_INCLUDE_UNDATABLE'] === 'true';

  const sql = postgres(url, { ssl: 'require', max: 1 });
  try {
    const r = await sweepLeakedTestTenants(sql, {
      maxAgeHours,
      apply,
      includeUndatable,
      allowTriggerDisable: true,
      log: (line) => console.log(line),
    });

    console.log(
      `\n${r.slugs} test tenant slugs found across those tables\n` +
        `  ${r.eligible.length} eligible (newest row older than ${maxAgeHours} h)\n` +
        `  ${r.tooRecent.length} skipped — too recent, another run may own them\n` +
        `  ${r.undatable.length} carry no created_at anywhere` +
        `${includeUndatable ? ' (INCLUDED)' : ' (skipped; CLEANUP_INCLUDE_UNDATABLE=true to include)'}`,
    );
    if (r.tooRecent.length > 0) {
      console.log(`  recent, untouched: ${r.tooRecent.slice(0, 10).join(', ')}` +
        (r.tooRecent.length > 10 ? ` … +${r.tooRecent.length - 10}` : ''));
    }
    if (r.eligible.length === 0) {
      console.log('\nNothing to do.');
      return;
    }

    const plannedTotal = [...r.plannedPerTable.values()].reduce((a, b) => a + b, 0);
    console.log(`\nRows owned by the ${r.eligible.length} eligible tenants:`);
    for (const [tbl, n] of [...r.plannedPerTable].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tbl.padEnd(38)} ${String(n).padStart(7)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(38)} ${String(plannedTotal).padStart(7)}`);

    if (!apply) {
      console.log('\nDRY RUN — nothing deleted. Re-run with CLEANUP_APPLY=true.');
      return;
    }

    console.log('\nRows deleted per table:');
    let total = 0;
    for (const [tbl, count] of [...r.deletedPerTable].sort((a, b) => b[1] - a[1])) {
      if (count > 0) console.log(`  ${tbl.padEnd(38)} ${String(count).padStart(7)}`);
      total += count;
    }
    console.log(`  ${'TOTAL'.padEnd(38)} ${String(total).padStart(7)}`);
    console.log(
      `\n${r.fullyCleaned}/${r.eligible.length} tenants fully cleaned; ${r.stuck.length} left rows behind.`,
    );
    for (const s of r.stuck) {
      console.log(`  ${s.slug}: ${s.left.join(', ')}`);
    }
    if (r.stuck.length > 0) {
      console.log(
        '\nA tenant with `refunds` + `credit_notes` left is the settled-refund ↔ credit-note\n' +
          'RESTRICT cycle (see tests/integration/helpers/test-tenant.ts) — it cannot be broken\n' +
          'without disabling the credit_notes immutability trigger. Expected, not a failure.',
      );
    }
    console.log(
      '\naudit_log rows for these tenants are NOT deleted (append-only trigger by design).',
    );
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error('cleanup failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
