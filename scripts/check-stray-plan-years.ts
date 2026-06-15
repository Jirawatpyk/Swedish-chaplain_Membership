/**
 * Diagnose (and optionally clean up) STRAY `membership_plans` rows whose
 * `plan_year` is implausible.
 *
 * Background: SweCham's catalogue has accumulated inactive future-year
 * rows (e.g. `plan_year = 2068`, `2028`, `is_active = false`) — clone-to-year
 * test artifacts and/or a Buddhist-Era leak (2025 CE + 543 = 2568 BE;
 * a stray "2068" is a 2025-style typo or BE truncation). These are
 * catalogue noise and can confuse the F8 renewal plan-lookup
 * (`loadPlanFrozenFields` / `getAnnualFeeSatang`) which resolves the
 * most-recent active row per plan_id.
 *
 * "Implausible" = `plan_year > <currentYear>+1` OR `plan_year < 2020`.
 *   - The `> currentYear+1` arm catches far-future clone artifacts AND any
 *     BE-leaked value (a real BE year would be ≥ 2563).
 *   - The `< 2020` arm catches any below-floor garbage (the chamber's
 *     real catalogue starts at 2026; 2020 is a generous lower bound).
 *
 * Modes:
 *   - DRY-RUN (default)  — REPORT only; mutate nothing. Prints exactly which
 *                          rows WOULD be deleted under `--fix` and which would
 *                          be SKIPPED because they are still referenced.
 *   - `--fix`            — DELETE rows that are ALL of:
 *                            (a) `is_active = false`, AND
 *                            (b) implausible plan_year, AND
 *                            (c) NOT referenced by any
 *                                `renewal_cycles.plan_id_at_cycle_start`
 *                                (matched on `(tenant_id, plan_id)`) NOR any
 *                                `invoices.plan_id` (matched on the full
 *                                `(tenant_id, plan_id, plan_year)` FK key,
 *                                `invoices_plan_fk`).
 *                          Referenced rows are report-and-skipped (never
 *                          deleted) — guards against orphaning a live cycle
 *                          or breaking the tax-document FK.
 *
 * Why the bare `db` singleton (not `runInTenant`): this is a CROSS-TENANT
 * operator diagnostic. `runInTenant` scopes a transaction to ONE tenant via
 * `SET LOCAL app.current_tenant`, which cannot enumerate every tenant's
 * catalogue. The default `db` connects as the Neon owner role
 * (`rolbypassrls = TRUE`), so RLS is bypassed and explicit `tenant_id`
 * predicates / `GROUP BY tenant_id` do the scoping in SQL — the same
 * established pattern used by `scripts/clear-test-data.ts` and
 * `scripts/cleanup-orphan-receipts.ts`. Active (`is_active = true`) rows are
 * NEVER deleted regardless of year, so even a mis-flagged active row is safe.
 *
 * Run via:
 *   node --env-file=.env.local --import tsx scripts/check-stray-plan-years.ts
 *   node --env-file=.env.local --import tsx scripts/check-stray-plan-years.ts --fix
 *
 * Safe to run repeatedly (idempotent — a clean catalogue reports/deletes
 * nothing).
 */
process.loadEnvFile?.('.env.local');

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

// Lower bound for a plausible catalogue year. The chamber's real
// catalogue begins at 2026; 2020 is a generous floor that still catches
// below-range garbage without risking a legitimate historical row.
const MIN_PLAUSIBLE_YEAR = 2020;

/** Implausible if strictly above next year, OR below the floor. */
export function isImplausiblePlanYear(
  planYear: number,
  currentYear: number,
): boolean {
  return planYear > currentYear + 1 || planYear < MIN_PLAUSIBLE_YEAR;
}

/** One stray catalogue row, with its English display name and ref state. */
export interface StrayPlanRow {
  readonly tenantId: string;
  readonly planId: string;
  readonly planYear: number;
  readonly isActive: boolean;
  /** English plan name (jsonb `plan_name->>'en'`); `null` if absent. */
  readonly nameEn: string | null;
  /** Count of `renewal_cycles` referencing this `(tenant_id, plan_id)`. */
  readonly renewalCycleRefs: number;
  /** Count of `invoices` referencing the full `(tenant_id, plan_id, plan_year)`. */
  readonly invoiceRefs: number;
}

export interface CheckStrayPlanYearsReport {
  readonly currentYear: number;
  readonly fix: boolean;
  /** Every implausible-year row found, regardless of active/ref state. */
  readonly strayRows: readonly StrayPlanRow[];
  /** Implausible + inactive + unreferenced → eligible to delete under `--fix`. */
  readonly deletable: readonly StrayPlanRow[];
  /** Implausible but referenced (or active) → reported but never deleted. */
  readonly skipped: readonly StrayPlanRow[];
  /** Rows actually deleted (`--fix` only; empty in dry-run). */
  readonly deleted: readonly StrayPlanRow[];
}

// Helper: normalize db.execute result across postgres-js drivers that
// may return either an array directly or `{ rows: [...] }`. (Mirrors
// scripts/clear-test-data.ts.)
function unwrap<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

// Strict variant for the DESTRUCTIVE DELETE path: a `db.execute` whose
// RETURNING result is neither an array nor `{ rows: [...] }` means the driver
// envelope changed — the lenient `unwrap` would silently return `[]` and the
// report would claim "DELETED 0" while rows were actually removed (070
// speckit-review errors I-1). An EMPTY result (0 deleted — e.g. every
// candidate was concurrently flipped active and skipped by the DELETE's
// `is_active = false` guard) is still LEGITIMATE and returns `[]`; only an
// UNRECOGNIZED shape throws. (This is why we don't assert
// `result.length === deletable.length` — a smaller count is a valid
// concurrent-flip outcome, not a driver fault.)
function unwrapStrict<T>(result: unknown, context: string): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    result &&
    typeof result === 'object' &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  throw new Error(
    `check-stray-plan-years: ${context} returned an unrecognized db.execute ` +
      `result shape (neither array nor { rows: [] }); aborting before reporting ` +
      `a misleading deletion count — a postgres-js/Drizzle upgrade may have ` +
      `changed the result envelope.`,
  );
}

interface RawStrayRow {
  readonly tenant_id: string;
  readonly plan_id: string;
  readonly plan_year: number;
  readonly is_active: boolean;
  readonly name_en: string | null;
  readonly renewal_cycle_refs: number;
  readonly invoice_refs: number;
}

/**
 * Scan + (optionally) clean stray-plan-year rows. Exported as a pure
 * function so it can be covered by an integration test against live Neon.
 *
 * `currentYear` is injectable for deterministic testing; defaults to the
 * UTC calendar year at call time.
 */
export async function checkStrayPlanYears(options?: {
  readonly fix?: boolean;
  readonly currentYear?: number;
}): Promise<CheckStrayPlanYearsReport> {
  const fix = options?.fix ?? false;
  const currentYear = options?.currentYear ?? new Date().getUTCFullYear();
  const maxPlausible = currentYear + 1;

  // Report ALL implausible-year rows across ALL tenants, each annotated
  // with its English name + reference counts. Correlated subqueries keep
  // the reference check tenant-scoped:
  //   - renewal_cycles refs match (tenant_id, plan_id) — the cycle column
  //     `plan_id_at_cycle_start` carries no plan_year, so a cycle on plan X
  //     protects every year of plan X within its tenant (conservative).
  //   - invoices refs match the full (tenant_id, plan_id, plan_year) FK.
  // Ordered tenant → year so the operator-facing report groups cleanly.
  const rows = unwrap<RawStrayRow>(
    await db.execute(sql`
      SELECT
        p.tenant_id,
        p.plan_id,
        p.plan_year,
        p.is_active,
        p.plan_name->>'en' AS name_en,
        (
          SELECT count(*)::int FROM renewal_cycles rc
          WHERE rc.tenant_id = p.tenant_id
            AND rc.plan_id_at_cycle_start = p.plan_id
        ) AS renewal_cycle_refs,
        (
          SELECT count(*)::int FROM invoices i
          WHERE i.tenant_id = p.tenant_id
            AND i.plan_id = p.plan_id
            AND i.plan_year = p.plan_year
        ) AS invoice_refs
      FROM membership_plans p
      WHERE p.plan_year > ${maxPlausible}
         OR p.plan_year < ${MIN_PLAUSIBLE_YEAR}
      ORDER BY p.tenant_id ASC, p.plan_year ASC, p.plan_id ASC
    `),
  );

  const strayRows: StrayPlanRow[] = rows.map((r) => ({
    tenantId: r.tenant_id,
    planId: r.plan_id,
    planYear: r.plan_year,
    isActive: r.is_active,
    nameEn: r.name_en,
    renewalCycleRefs: r.renewal_cycle_refs,
    invoiceRefs: r.invoice_refs,
  }));

  const isReferenced = (row: StrayPlanRow): boolean =>
    row.renewalCycleRefs > 0 || row.invoiceRefs > 0;

  // Deletable = inactive AND unreferenced. Active rows + referenced rows
  // are skipped (reported, never mutated).
  const deletable = strayRows.filter(
    (row) => !row.isActive && !isReferenced(row),
  );
  const skipped = strayRows.filter(
    (row) => row.isActive || isReferenced(row),
  );

  const deleted: StrayPlanRow[] = [];
  if (fix && deletable.length > 0) {
    // Delete by exact PK tuples (tenant_id, plan_id, plan_year). The
    // WHERE re-asserts is_active = false + the implausible-year predicate
    // as a belt-and-suspenders guard so a concurrent flip-to-active
    // between SELECT and DELETE cannot delete a now-active row.
    const pkTuples = sql.join(
      deletable.map(
        (row) =>
          sql`(${row.tenantId}, ${row.planId}, ${row.planYear})`,
      ),
      sql`, `,
    );
    const result = unwrapStrict<{ tenant_id: string; plan_id: string; plan_year: number }>(
      await db.execute(sql`
        DELETE FROM membership_plans
        WHERE (tenant_id, plan_id, plan_year) IN (${pkTuples})
          AND is_active = false
          AND (plan_year > ${maxPlausible} OR plan_year < ${MIN_PLAUSIBLE_YEAR})
        RETURNING tenant_id, plan_id, plan_year
      `),
      'stray-plan DELETE RETURNING',
    );
    const deletedKeys = new Set(
      result.map((r) => `${r.tenant_id}::${r.plan_id}::${r.plan_year}`),
    );
    for (const row of deletable) {
      if (deletedKeys.has(`${row.tenantId}::${row.planId}::${row.planYear}`)) {
        deleted.push(row);
      }
    }
  }

  return { currentYear, fix, strayRows, deletable, skipped, deleted };
}

function describeRow(row: StrayPlanRow): string {
  const name = row.nameEn ?? '(no en name)';
  const refs =
    row.renewalCycleRefs > 0 || row.invoiceRefs > 0
      ? ` [refs: cycles=${row.renewalCycleRefs} invoices=${row.invoiceRefs}]`
      : '';
  return (
    `    tenant=${row.tenantId} plan_id=${row.planId} ` +
    `plan_year=${row.planYear} is_active=${row.isActive} ` +
    `name="${name}"${refs}`
  );
}

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix');
  console.log('');
  console.log('=== check-stray-plan-years ===');
  console.log(`Mode: ${fix ? 'FIX (destructive — deletes eligible rows)' : 'DRY-RUN (report only)'}`);

  const report = await checkStrayPlanYears({ fix });

  console.log(
    `Implausible-year predicate: plan_year > ${report.currentYear + 1} OR plan_year < ${MIN_PLAUSIBLE_YEAR}`,
  );
  console.log('');

  if (report.strayRows.length === 0) {
    console.log('No stray plan_year rows found. Catalogue is clean.');
    console.log('');
    return;
  }

  // Group the full stray set by tenant for an at-a-glance report.
  const byTenant = new Map<string, StrayPlanRow[]>();
  for (const row of report.strayRows) {
    const list = byTenant.get(row.tenantId) ?? [];
    list.push(row);
    byTenant.set(row.tenantId, list);
  }
  console.log(`Found ${report.strayRows.length} stray row(s) across ${byTenant.size} tenant(s):`);
  for (const [tenantId, list] of byTenant) {
    console.log(`  tenant=${tenantId} (${list.length} row(s)):`);
    for (const row of list) {
      console.log(describeRow(row));
    }
  }
  console.log('');

  console.log(`Deletable (inactive + unreferenced): ${report.deletable.length}`);
  for (const row of report.deletable) {
    console.log(describeRow(row));
  }
  console.log('');

  console.log(`Skipped (active OR referenced — will NOT delete): ${report.skipped.length}`);
  for (const row of report.skipped) {
    console.log(describeRow(row));
  }
  console.log('');

  if (fix) {
    console.log(`DELETED ${report.deleted.length} row(s).`);
  } else if (report.deletable.length > 0) {
    console.log(
      `DRY-RUN — would delete ${report.deletable.length} row(s). Re-run with --fix to apply.`,
    );
  }
  console.log('');
  console.log('check-stray-plan-years: done');
}

// Only auto-run when invoked directly, not when imported by the test.
const invokedDirectly =
  process.argv[1]?.endsWith('check-stray-plan-years.ts') === true ||
  process.argv[1]?.endsWith('check-stray-plan-years.js') === true;
if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('check-stray-plan-years failed:', err);
      process.exit(1);
    });
}
