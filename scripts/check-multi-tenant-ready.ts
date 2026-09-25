/**
 * F8 Phase 2 Wave C · T029 — multi-tenant readiness check.
 *
 * Verifies that every tenant-scoped table in the schema honours the
 * Constitution v1.4.0 Principle I (tenant isolation, NON-NEGOTIABLE)
 * two-layer-defence contract:
 *
 *   1. The table has a `tenant_id` column.
 *   2. RLS is ENABLED on the table (`relrowsecurity = true`).
 *   3. RLS is FORCED (`relforcerowsecurity = true`) — the FORCE clause
 *      is what makes the policy apply to the table OWNER too, not just
 *      to other roles. Without it, drizzle-kit migrations (run as
 *      owner) bypass RLS silently — a P1 leak vector.
 *   4. At least one policy exists with USING/WITH CHECK referencing
 *      `app.current_tenant`.
 *   5. No row has `tenant_id IS NULL` (sentinel scan; an existing
 *      orphan row would survive RLS by appearing in NO tenant context).
 *
 * Wired into `package.json` as `pnpm check:multi-tenant` and the full
 * CI chain. Failure exits non-zero with a per-table breakdown.
 *
 * Scope decision (Wave B verify-run E1 + D5): runs against the
 * EXPLICIT_TABLES allow-list rather than discovering tables via
 * `information_schema` introspection. Allow-list keeps the script
 * deterministic + lets us flag forgotten new tables (the failure case
 * "table exists in schema but not in allow-list" is what we want to
 * surface to the engineer adding a table without registering it here).
 *
 * #400 PR-B — that failure case was only ever a promise: nothing compared the
 * allow-list with the schema, and fifteen `tenant_id` tables sat unregistered
 * (so unchecked) while the gate reported OK. The positive control
 * (`scripts/lib/multi-tenant-coverage.ts`) now parses every Drizzle table
 * that declares `tenant_id` and fails when one is in none of SCOPED_TABLES,
 * LEGACY_KNOWN_GAPS or EXEMPT, or when the parse finds nothing at all.
 */
// `package.json` invokes this script via `node --env-file=.env.local`
// so `process.env.DATABASE_URL` and the rest of the zod-validated env
// surface (see `src/lib/env.ts`) are populated before the import below
// runs the schema validator.
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import {
  checkCoverage,
  parseTenantScopedTables,
  readSchemaSources,
} from './lib/multi-tenant-coverage';
// #400 W1 — the lists live in `./lib/multi-tenant-registry` (with their triage
// notes), so the unit suite can hold the real schema against them.
import { EXEMPT, LEGACY_KNOWN_GAPS, SCOPED_TABLES } from './lib/multi-tenant-registry';

/**
 * Tables that are tenant-scoped but DON'T have a literal `tenant_id`
 * column because they're keyed differently. Currently empty — Chamber-OS
 * uses `tenant_id` everywhere as of /speckit.implement Wave C.
 */
const TENANT_SCOPED_NO_TENANT_ID_COLUMN: ReadonlyArray<string> = [];

interface CheckResult {
  readonly table: string;
  readonly hasTenantIdColumn: boolean;
  readonly relrowsecurity: boolean;
  readonly relforcerowsecurity: boolean;
  readonly policyCount: number;
  readonly policyReferencesAppCurrentTenant: boolean;
  readonly nullTenantIdRowCount: number | null; // null if hasTenantIdColumn = false
}

async function checkTable(table: string): Promise<CheckResult> {
  const expectsTenantIdColumn = !TENANT_SCOPED_NO_TENANT_ID_COLUMN.includes(
    table,
  );

  // Column existence.
  const colRows: Array<{ column_name: string }> = (await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = 'tenant_id'
  `)) as never;
  const hasTenantIdColumn = colRows.length > 0;

  // RLS state.
  const relRows: Array<{
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }> = (await db.execute(sql`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE relname = ${table} AND relkind = 'r'
  `)) as never;
  const rel = relRows[0];
  const relrowsecurity = rel?.relrowsecurity ?? false;
  const relforcerowsecurity = rel?.relforcerowsecurity ?? false;

  // Policy state — we want at least one policy whose qual or with_check
  // text mentions `app.current_tenant`.
  const policyRows: Array<{ qual: string | null; with_check: string | null }> =
    (await db.execute(sql`
      SELECT pg_get_expr(polqual, polrelid) AS qual,
             pg_get_expr(polwithcheck, polrelid) AS with_check
      FROM pg_policy
      WHERE polrelid = (SELECT oid FROM pg_class WHERE relname = ${table})
    `)) as never;
  const policyCount = policyRows.length;
  const policyReferencesAppCurrentTenant = policyRows.some((p) =>
    [p.qual ?? '', p.with_check ?? ''].some((expr) =>
      expr.includes('app.current_tenant'),
    ),
  );

  // NULL tenant_id row scan — only if the column exists.
  let nullTenantIdRowCount: number | null = null;
  if (hasTenantIdColumn) {
    const result: Array<{ n: string | number }> = (await db.execute(
      sql.raw(
        `SELECT COUNT(*)::text AS n FROM "${table}" WHERE tenant_id IS NULL`,
      ),
    )) as never;
    nullTenantIdRowCount = Number(result[0]?.n ?? 0);
  }

  return {
    table,
    hasTenantIdColumn: expectsTenantIdColumn ? hasTenantIdColumn : true,
    relrowsecurity,
    relforcerowsecurity,
    policyCount,
    policyReferencesAppCurrentTenant,
    nullTenantIdRowCount,
  };
}

interface Failure {
  readonly table: string;
  readonly reasons: readonly string[];
}

function classifyFailures(results: readonly CheckResult[]): Failure[] {
  const failures: Failure[] = [];
  for (const r of results) {
    const reasons: string[] = [];
    if (!r.hasTenantIdColumn) reasons.push('missing tenant_id column');
    if (!r.relrowsecurity) reasons.push('RLS not ENABLED (relrowsecurity=f)');
    if (!r.relforcerowsecurity) {
      reasons.push(
        'RLS not FORCED (relforcerowsecurity=f) — owner queries bypass RLS',
      );
    }
    if (r.policyCount === 0) reasons.push('no RLS policy attached');
    if (!r.policyReferencesAppCurrentTenant) {
      reasons.push('no policy references `app.current_tenant`');
    }
    if (r.nullTenantIdRowCount !== null && r.nullTenantIdRowCount > 0) {
      reasons.push(
        `${r.nullTenantIdRowCount} row(s) with NULL tenant_id (orphan)`,
      );
    }
    if (reasons.length > 0) failures.push({ table: r.table, reasons });
  }
  return failures;
}

/**
 * #400 PR-B — the positive control: the lists above must cover the schema.
 * Runs before any database read, so a blind or stale list fails even when the
 * database is unreachable.
 */
function assertListsCoverSchema(): void {
  const parsed = parseTenantScopedTables(readSchemaSources(process.cwd()));
  const { failures } = checkCoverage(parsed, {
    scoped: SCOPED_TABLES,
    legacy: LEGACY_KNOWN_GAPS,
    exempt: EXEMPT,
  });
  if (failures.length > 0) {
    console.error(
      `[check:multi-tenant] ✗ the allow-lists do not cover the schema (${parsed.tables.length} tenant_id tables parsed):`,
    );
    for (const f of failures) console.error(`  • ${f}`);
    process.exit(1);
  }
  console.log(
    `[check:multi-tenant] ✓ positive control: ${parsed.tables.length} tenant_id tables parsed from the Drizzle schema, ` +
      `all registered (${SCOPED_TABLES.length} scoped + ${LEGACY_KNOWN_GAPS.length} legacy + ${EXEMPT.length} exempt)`,
  );
}

async function main(): Promise<void> {
  assertListsCoverSchema();
  console.log(
    `[check:multi-tenant] auditing ${SCOPED_TABLES.length} scoped tables ` +
      `+ ${LEGACY_KNOWN_GAPS.length} legacy-tracked tables…`,
  );

  const scopedResults: CheckResult[] = [];
  for (const table of SCOPED_TABLES) {
    scopedResults.push(await checkTable(table));
  }
  const legacyResults: CheckResult[] = [];
  for (const table of LEGACY_KNOWN_GAPS) {
    legacyResults.push(await checkTable(table));
  }

  const scopedFailures = classifyFailures(scopedResults);
  const legacyFailures = classifyFailures(legacyResults);

  if (legacyFailures.length > 0) {
    console.warn(
      `[check:multi-tenant] ⚠  ${legacyFailures.length} legacy-tracked ` +
        `table(s) with KNOWN gaps (Phase 10 cleanup; not blocking):`,
    );
    for (const f of legacyFailures) {
      console.warn(`  • ${f.table}`);
      for (const r of f.reasons) console.warn(`      ${r}`);
    }
  }

  if (scopedFailures.length === 0) {
    console.log(
      `[check:multi-tenant] ✓ all ${SCOPED_TABLES.length} scoped tables OK`,
    );
    process.exit(0);
  }

  console.error(
    `[check:multi-tenant] ✗ ${scopedFailures.length} scoped table(s) ` +
      `FAILED (regressions — fix before merge):`,
  );
  for (const f of scopedFailures) {
    console.error(`  • ${f.table}`);
    for (const r of f.reasons) console.error(`      ${r}`);
  }
  process.exit(1);
}

main().catch((e) => {
  console.error('[check:multi-tenant] fatal:', e);
  process.exit(1);
});
