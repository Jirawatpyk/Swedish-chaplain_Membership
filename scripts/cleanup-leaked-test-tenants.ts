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
 * Usage (dry run first — it prints exactly what it would delete):
 *   node --env-file=.env.local --import tsx scripts/cleanup-leaked-test-tenants.ts
 *   CLEANUP_APPLY=true node --env-file=.env.local --import tsx \
 *     scripts/cleanup-leaked-test-tenants.ts
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

/** Append-only: the DELETE is blocked by a trigger, so never attempt it. */
const NEVER_DELETE = new Set(['audit_log']);

/** Trigger that RAISEs on DELETE; disabled inside the tenant's own tx. */
const DELETE_BLOCKING_TRIGGERS: ReadonlyMap<string, string> = new Map([
  ['broadcast_deliveries', 'broadcast_deliveries_no_delete'],
]);

const TEST_SLUG = /^test(-|$)/;
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

interface TableInfo {
  readonly name: string;
  readonly hasCreatedAt: boolean;
}

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
    // ── Discover the tenant-scoped base tables ───────────────────────────────
    const discovered = (await sql`
      SELECT c.table_name AS name,
             bool_or(c2.column_name = 'created_at') AS has_created_at
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name = c.table_name
         AND t.table_type = 'BASE TABLE'
        LEFT JOIN information_schema.columns c2
          ON c2.table_schema = c.table_schema
         AND c2.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'tenant_id'
        GROUP BY c.table_name
        ORDER BY c.table_name
    `) as unknown as Array<{ name: string; has_created_at: boolean }>;

    const tables: TableInfo[] = discovered
      .filter((r) => !NEVER_DELETE.has(r.name))
      .map((r) => {
        if (!SAFE_IDENT.test(r.name)) {
          throw new Error(`unexpected table name from catalogue: ${r.name}`);
        }
        return { name: r.name, hasCreatedAt: r.has_created_at === true };
      });
    console.log(
      `${tables.length} tenant-scoped base tables in scope ` +
        `(${[...NEVER_DELETE].join(', ')} excluded — append-only)`,
    );

    // ── Candidate slugs + the age of the newest row each one owns ────────────
    const slugUnion = tables
      .map((t) => `SELECT DISTINCT tenant_id FROM "${t.name}" WHERE tenant_id LIKE 'test%'`)
      .join(' UNION ');
    const slugRows = (await sql.unsafe(
      `SELECT tenant_id FROM (${slugUnion}) u ORDER BY tenant_id`,
    )) as unknown as Array<{ tenant_id: string }>;
    const slugs = slugRows.map((r) => r.tenant_id).filter((s) => TEST_SLUG.test(s));

    const datable = tables.filter((t) => t.hasCreatedAt);
    const ageUnion = datable
      .map(
        (t) =>
          `SELECT tenant_id, max(created_at) AS newest FROM "${t.name}" ` +
          `WHERE tenant_id LIKE 'test%' GROUP BY tenant_id`,
      )
      .join(' UNION ALL ');
    const ageRows = (await sql.unsafe(`
      SELECT tenant_id, max(newest) AS newest
        FROM (${ageUnion}) a
       GROUP BY tenant_id
    `)) as unknown as Array<{ tenant_id: string; newest: Date }>;
    const newestBySlug = new Map(ageRows.map((r) => [r.tenant_id, r.newest]));

    const cutoff = Date.now() - maxAgeHours * 3_600_000;
    const eligible: string[] = [];
    const tooRecent: string[] = [];
    const undatable: string[] = [];
    for (const slug of slugs) {
      const newest = newestBySlug.get(slug);
      if (newest === undefined) {
        undatable.push(slug);
        if (includeUndatable) eligible.push(slug);
        continue;
      }
      if (newest.getTime() < cutoff) eligible.push(slug);
      else tooRecent.push(slug);
    }

    console.log(
      `\n${slugs.length} test tenant slugs found across those tables\n` +
        `  ${eligible.length} eligible (newest row older than ${maxAgeHours} h)\n` +
        `  ${tooRecent.length} skipped — too recent, another run may own them\n` +
        `  ${undatable.length} carry no created_at anywhere` +
        `${includeUndatable ? ' (INCLUDED)' : ' (skipped; CLEANUP_INCLUDE_UNDATABLE=true to include)'}`,
    );
    if (tooRecent.length > 0) {
      console.log(`  recent, untouched: ${tooRecent.slice(0, 10).join(', ')}` +
        (tooRecent.length > 10 ? ` … +${tooRecent.length - 10}` : ''));
    }
    if (eligible.length === 0) {
      console.log('\nNothing to do.');
      return;
    }

    // ── What each eligible tenant still owns ─────────────────────────────────
    const countsUnion = tables
      .map(
        (t) =>
          `SELECT '${t.name}' AS tbl, tenant_id, count(*)::int AS n FROM "${t.name}" ` +
          `WHERE tenant_id = ANY($1) GROUP BY tenant_id`,
      )
      .join(' UNION ALL ');
    const owned = (await sql.unsafe(countsUnion, [eligible])) as unknown as Array<{
      tbl: string;
      tenant_id: string;
      n: number;
    }>;
    const ownedByTenant = new Map<string, Map<string, number>>();
    const plannedPerTable = new Map<string, number>();
    for (const r of owned) {
      let m = ownedByTenant.get(r.tenant_id);
      if (m === undefined) {
        m = new Map();
        ownedByTenant.set(r.tenant_id, m);
      }
      m.set(r.tbl, r.n);
      plannedPerTable.set(r.tbl, (plannedPerTable.get(r.tbl) ?? 0) + r.n);
    }
    const plannedTotal = [...plannedPerTable.values()].reduce((a, b) => a + b, 0);
    console.log(`\nRows owned by the ${eligible.length} eligible tenants:`);
    for (const [tbl, n] of [...plannedPerTable].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tbl.padEnd(38)} ${String(n).padStart(7)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(38)} ${String(plannedTotal).padStart(7)}`);

    if (!apply) {
      console.log('\nDRY RUN — nothing deleted. Re-run with CLEANUP_APPLY=true.');
      return;
    }

    // ── Delete, one transaction per tenant, draining by retry ────────────────
    const deletedPerTable = new Map<string, number>();
    const stuck: Array<{ slug: string; left: string[] }> = [];
    let fullyCleaned = 0;
    let n = 0;
    for (const slug of eligible) {
      n += 1;
      const ownedTables = [...(ownedByTenant.get(slug) ?? new Map()).keys()];
      try {
        const left = await sql.begin(async (tx) => {
          let remaining = [...ownedTables];
          for (let pass = 0; pass < remaining.length + 1 && remaining.length > 0; pass += 1) {
            const failed: string[] = [];
            for (const tbl of remaining) {
              const trigger = DELETE_BLOCKING_TRIGGERS.get(tbl);
              try {
                await tx.savepoint(async (sp) => {
                  if (trigger !== undefined) {
                    await sp.unsafe(`ALTER TABLE "${tbl}" DISABLE TRIGGER "${trigger}"`);
                  }
                  const r = await sp.unsafe(`DELETE FROM "${tbl}" WHERE tenant_id = $1`, [slug]);
                  if (trigger !== undefined) {
                    await sp.unsafe(`ALTER TABLE "${tbl}" ENABLE TRIGGER "${trigger}"`);
                  }
                  deletedPerTable.set(tbl, (deletedPerTable.get(tbl) ?? 0) + r.count);
                });
              } catch {
                failed.push(tbl);
              }
            }
            if (failed.length === remaining.length) return failed; // no progress
            remaining = failed;
          }
          return remaining;
        });
        if (left.length === 0) fullyCleaned += 1;
        else stuck.push({ slug, left });
      } catch (e) {
        stuck.push({
          slug,
          left: [`<tx failed: ${e instanceof Error ? e.message : String(e)}>`],
        });
      }
      if (n % 25 === 0) console.log(`  … ${n}/${eligible.length} tenants processed`);
    }

    console.log('\nRows deleted per table:');
    let total = 0;
    for (const [tbl, count] of [...deletedPerTable].sort((a, b) => b[1] - a[1])) {
      if (count > 0) console.log(`  ${tbl.padEnd(38)} ${String(count).padStart(7)}`);
      total += count;
    }
    console.log(`  ${'TOTAL'.padEnd(38)} ${String(total).padStart(7)}`);
    console.log(
      `\n${fullyCleaned}/${eligible.length} tenants fully cleaned; ${stuck.length} left rows behind.`,
    );
    for (const s of stuck) {
      console.log(`  ${s.slug}: ${s.left.join(', ')}`);
    }
    if (stuck.length > 0) {
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
