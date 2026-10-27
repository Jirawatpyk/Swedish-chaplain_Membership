/**
 * Delete the rows left behind by throwaway integration-test tenants — the
 * shared core of `scripts/cleanup-leaked-test-tenants.ts` (an operator run)
 * and the integration globalSetup's automatic sweep (135).
 *
 * Why it matters: several crons are PLATFORM crons that enumerate every tenant
 * and sweep one per round trip, so each leaked `test-*` tenant slows every
 * such cron and every test that drives one (2026-09-27: 99 tenants timed out
 * a 60 s test; 2026-10-27: 168 blocked a pre-push for hours).
 *
 *   - Discovers every tenant-scoped BASE TABLE from `information_schema`, so a
 *     table added later is still cleaned. `audit_log` is never touched: its
 *     append-only trigger blocks DELETE by design.
 *   - Only slugs matching /^test(-|$)/.
 *   - Age filter: a tenant is eligible only when the newest row it owns is
 *     older than `maxAgeHours`. The dev branch is shared; there is no other
 *     way to tell a live fixture from litter.
 *   - One transaction per tenant, draining the table list in repeated passes
 *     with a savepoint per DELETE, so FK order never has to be maintained.
 *
 * Imports `postgres` only (no `@/`), so tsx scripts and vitest both load it.
 */
import type postgres from 'postgres';

/** Append-only: the DELETE is blocked by a trigger, so never attempt it. */
const NEVER_DELETE = new Set(['audit_log']);

/** Trigger that RAISEs on DELETE; only an operator run may disable it. */
const DELETE_BLOCKING_TRIGGERS: ReadonlyMap<string, string> = new Map([
  ['broadcast_deliveries', 'broadcast_deliveries_no_delete'],
]);

const TEST_SLUG = /^test(-|$)/;

/**
 * The slugs `createTestTenant` mints (`test-<prefix>-<8 hex>`), never reused.
 * The automatic sweep takes only these: a fixed-slug fixture
 * (`test-suppression-explain`, ...) may be rewritten by a run in progress
 * after its age was read, so it is left to the operator script.
 */
export const GENERATED_TEST_SLUG = /^test(-[a-z]+)*-[0-9a-f]{8}$/;
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

export interface SweepOptions {
  readonly maxAgeHours: number;
  readonly apply: boolean;
  /** Also take tenants whose tables carry no `created_at` (age unknowable). */
  readonly includeUndatable: boolean;
  /**
   * Allow `ALTER TABLE … DISABLE TRIGGER` for a delete-guarded table. Only an
   * operator run: it takes an ACCESS EXCLUSIVE lock on a table other sessions
   * on the shared branch are using. The automatic sweep passes `false`.
   */
  readonly allowTriggerDisable: boolean;
  /**
   * Skip a tenant this sweep cannot fully drain, so an automatic run does not
   * retry it every time: one an earlier sweep drained down to the
   * settled-refund ↔ credit-note RESTRICT cycle, or one that owns a
   * delete-guarded table while `allowTriggerDisable` is false. The operator
   * script handles both.
   */
  readonly skipUndrainable?: boolean;
  /** Restrict the candidates to these slugs (tests). */
  readonly onlySlugs?: readonly string[];
  /** Restrict the candidates to slugs matching this pattern. */
  readonly slugPattern?: RegExp;
  /**
   * Stop starting tenants after this many ms; the rest wait for the next run
   * (`skippedBudget`). Each tenant is its own transaction, so stopping early
   * leaves nothing half-done.
   */
  readonly budgetMs?: number;
  /** Per-tenant transaction `lock_timeout` / `statement_timeout`, in ms. */
  readonly lockTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface SweepReport {
  readonly tables: number;
  readonly slugs: number;
  readonly eligible: readonly string[];
  readonly tooRecent: readonly string[];
  readonly undatable: readonly string[];
  readonly skippedStuck: readonly string[];
  readonly skippedBudget: readonly string[];
  readonly plannedPerTable: ReadonlyMap<string, number>;
  readonly deletedPerTable: ReadonlyMap<string, number>;
  readonly fullyCleaned: number;
  readonly stuck: ReadonlyArray<{ readonly slug: string; readonly left: readonly string[] }>;
}

/**
 * The statements that delete one tenant's rows from `table`, or `null` when
 * the table is delete-guarded and disabling its trigger is not allowed.
 */
export function deleteStatementsFor(table: string, allowTriggerDisable: boolean): string[] | null {
  const del = `DELETE FROM "${table}" WHERE tenant_id = $1`;
  const trigger = DELETE_BLOCKING_TRIGGERS.get(table);
  if (trigger === undefined) return [del];
  if (!allowTriggerDisable) return null;
  return [
    `ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`,
    del,
    `ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`,
  ];
}

/**
 * A tenant left by an earlier sweep: it still owns both sides of the
 * settled-refund ↔ credit-note RESTRICT cycle (which no DELETE order breaks)
 * but no longer owns its `tenant_invoice_settings` row, which the first drain
 * removes and which is what the platform crons enumerate.
 */
export function isStuckOnRefundCreditNoteCycle(ownedTables: readonly string[]): boolean {
  const owned = new Set(ownedTables);
  return owned.has('refunds') && owned.has('credit_notes') && !owned.has('tenant_invoice_settings');
}

/**
 * Split candidates into those to sweep and those to skip as undrainable
 * (`skipUndrainable`), from what each one owns. Pure, so the wiring is unit
 * tested apart from the database.
 */
export function partitionCandidates(
  candidates: readonly string[],
  ownedByTenant: ReadonlyMap<string, ReadonlyMap<string, number>>,
  opts: Pick<SweepOptions, 'allowTriggerDisable' | 'skipUndrainable'>,
): { eligible: string[]; skippedStuck: string[] } {
  const eligible: string[] = [];
  const skippedStuck: string[] = [];
  for (const slug of candidates) {
    const ownedTables = [...(ownedByTenant.get(slug)?.keys() ?? [])];
    // Both shapes are skipped only once an earlier drain has removed the
    // tenant's `tenant_invoice_settings` row (the list the platform crons
    // enumerate), so the first run still takes the tenant off that list.
    const undrainable =
      isStuckOnRefundCreditNoteCycle(ownedTables) ||
      (!ownedTables.includes('tenant_invoice_settings') &&
        ownedTables.some((t) => deleteStatementsFor(t, opts.allowTriggerDisable) === null));
    if (opts.skipUndrainable === true && undrainable) skippedStuck.push(slug);
    else eligible.push(slug);
  }
  return { eligible, skippedStuck };
}

/**
 * What the integration globalSetup runs on every `pnpm test:integration`:
 * generated slugs only, 6 h age filter, no trigger disable, undrainable
 * tenants skipped, bounded in time and per statement. Pinned by a unit test.
 */
export const AUTOMATIC_SWEEP_OPTIONS = {
  maxAgeHours: 6,
  apply: true,
  includeUndatable: false,
  allowTriggerDisable: false,
  skipUndrainable: true,
  slugPattern: GENERATED_TEST_SLUG,
  budgetMs: 20_000,
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 30_000,
} as const satisfies SweepOptions;

export async function sweepLeakedTestTenants(
  sql: postgres.Sql,
  opts: SweepOptions,
): Promise<SweepReport> {
  const log = opts.log ?? (() => undefined);

  // ── Discover the tenant-scoped base tables ─────────────────────────────────
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

  const tables = discovered
    .filter((r) => !NEVER_DELETE.has(r.name))
    .map((r) => {
      if (!SAFE_IDENT.test(r.name)) {
        throw new Error(`unexpected table name from catalogue: ${r.name}`);
      }
      return { name: r.name, hasCreatedAt: r.has_created_at === true };
    });
  log(
    `${tables.length} tenant-scoped base tables in scope ` +
      `(${[...NEVER_DELETE].join(', ')} excluded — append-only)`,
  );

  // ── Candidate slugs + the age of the newest row each one owns ──────────────
  const slugUnion = tables
    .map((t) => `SELECT DISTINCT tenant_id FROM "${t.name}" WHERE tenant_id LIKE 'test%'`)
    .join(' UNION ');
  const slugRows = (await sql.unsafe(
    `SELECT tenant_id FROM (${slugUnion}) u ORDER BY tenant_id`,
  )) as unknown as Array<{ tenant_id: string }>;
  const only = opts.onlySlugs === undefined ? null : new Set(opts.onlySlugs);
  const slugs = slugRows
    .map((r) => r.tenant_id)
    .filter(
      (s) =>
        TEST_SLUG.test(s) &&
        (opts.slugPattern === undefined || opts.slugPattern.test(s)) &&
        (only === null || only.has(s)),
    );

  const ageUnion = tables
    .filter((t) => t.hasCreatedAt)
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

  const cutoff = Date.now() - opts.maxAgeHours * 3_600_000;
  const candidates: string[] = [];
  const tooRecent: string[] = [];
  const undatable: string[] = [];
  for (const slug of slugs) {
    const newest = newestBySlug.get(slug);
    if (newest === undefined) {
      undatable.push(slug);
      if (opts.includeUndatable) candidates.push(slug);
      continue;
    }
    if (newest.getTime() < cutoff) candidates.push(slug);
    else tooRecent.push(slug);
  }

  // ── What each candidate still owns ─────────────────────────────────────────
  const ownedByTenant = new Map<string, Map<string, number>>();
  if (candidates.length > 0) {
    const countsUnion = tables
      .map(
        (t) =>
          `SELECT '${t.name}' AS tbl, tenant_id, count(*)::int AS n FROM "${t.name}" ` +
          `WHERE tenant_id = ANY($1) GROUP BY tenant_id`,
      )
      .join(' UNION ALL ');
    const owned = (await sql.unsafe(countsUnion, [candidates])) as unknown as Array<{
      tbl: string;
      tenant_id: string;
      n: number;
    }>;
    for (const r of owned) {
      let m = ownedByTenant.get(r.tenant_id);
      if (m === undefined) {
        m = new Map();
        ownedByTenant.set(r.tenant_id, m);
      }
      m.set(r.tbl, r.n);
    }
  }

  const { eligible, skippedStuck } = partitionCandidates(candidates, ownedByTenant, opts);

  const plannedPerTable = new Map<string, number>();
  for (const slug of eligible) {
    for (const [tbl, n] of ownedByTenant.get(slug) ?? []) {
      plannedPerTable.set(tbl, (plannedPerTable.get(tbl) ?? 0) + n);
    }
  }

  const deletedPerTable = new Map<string, number>();
  const stuck: Array<{ slug: string; left: string[] }> = [];
  const skippedBudget: string[] = [];
  let fullyCleaned = 0;
  const report = (): SweepReport => ({
    tables: tables.length,
    slugs: slugs.length,
    eligible,
    tooRecent,
    undatable,
    skippedStuck,
    skippedBudget,
    plannedPerTable,
    deletedPerTable,
    fullyCleaned,
    stuck,
  });

  if (!opts.apply || eligible.length === 0) return report();

  // ── Delete, one transaction per tenant, draining by retry ──────────────────
  const started = Date.now();
  let n = 0;
  for (const slug of eligible) {
    if (opts.budgetMs !== undefined && Date.now() - started >= opts.budgetMs) {
      skippedBudget.push(slug);
      continue;
    }
    n += 1;
    const ownedTables = [...(ownedByTenant.get(slug) ?? new Map<string, number>()).keys()];
    const guarded = ownedTables.filter((t) => deleteStatementsFor(t, opts.allowTriggerDisable) === null);
    const deletable = ownedTables.filter((t) => !guarded.includes(t));
    try {
      const left = await sql.begin(async (tx) => {
        if (opts.lockTimeoutMs !== undefined) {
          await tx.unsafe(`SET LOCAL lock_timeout = ${Math.trunc(opts.lockTimeoutMs)}`);
        }
        if (opts.statementTimeoutMs !== undefined) {
          await tx.unsafe(`SET LOCAL statement_timeout = ${Math.trunc(opts.statementTimeoutMs)}`);
        }
        let remaining = [...deletable];
        for (let pass = 0; pass < remaining.length + 1 && remaining.length > 0; pass += 1) {
          const failed: string[] = [];
          for (const tbl of remaining) {
            const statements = deleteStatementsFor(tbl, opts.allowTriggerDisable) ?? [];
            try {
              let deleted = 0;
              await tx.savepoint(async (sp) => {
                for (const stmt of statements) {
                  const r = await sp.unsafe(stmt, stmt.includes('$1') ? [slug] : []);
                  if (stmt.startsWith('DELETE')) deleted += r.count;
                }
              });
              // Counted once the savepoint (and any trigger re-enable) held.
              deletedPerTable.set(tbl, (deletedPerTable.get(tbl) ?? 0) + deleted);
            } catch {
              failed.push(tbl);
            }
          }
          if (failed.length === remaining.length) return failed; // no progress
          remaining = failed;
        }
        return remaining;
      });
      const leftAll = [...left, ...guarded];
      if (leftAll.length === 0) fullyCleaned += 1;
      else stuck.push({ slug, left: leftAll });
    } catch (e) {
      stuck.push({ slug, left: [`<tx failed: ${e instanceof Error ? e.message : String(e)}>`] });
    }
    if (n % 25 === 0) log(`  … ${n}/${eligible.length} tenants processed`);
  }
  return report();
}
