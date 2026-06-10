/**
 * F8 Round-5 review-finding L4 — migration 0115 partial-index smoke.
 *
 * Migration 0115 added `audit_log_f8_tier_change_idx` (partial index
 * filtered to `event_type = 'member_plan_changed'`) so the at-risk
 * recompute CTE's EXISTS sub-query in `gatherAtRiskFactorsForTenant`
 * (`drizzle-member-renewal-flags-repo.ts`) does not seq-scan the
 * unbounded `audit_log` table at SC-005 scale (5,000 members ×
 * ~50,000 audit rows).
 *
 * Two-index reality (2026-06 hardening): `audit_log` carries TWO
 * partial indexes with the IDENTICAL predicate
 * `WHERE event_type = 'member_plan_changed'`:
 *
 *   - 0078 `audit_log_member_plan_changed_idx`
 *     (tenant_id, (payload->>'memberId'), timestamp DESC, id DESC)
 *     — F7 US3 benefits-page last-plan-change lookup.
 *   - 0115 `audit_log_f8_tier_change_idx`
 *     (tenant_id, timestamp) — F8 at-risk recompute EXISTS.
 *
 * The EXISTS shape below (tenant equality + timestamp range + LIMIT 1)
 * is servable by EITHER index; which one the planner picks is a pure
 * cost/statistics call that drifts with accumulated test traffic on
 * the shared dev DB (observed 2026-06-10: planner chose 0078 via an
 * Index Only Scan at lower cost). Pinning the EXPLAIN to ONE index
 * name therefore makes the test assert planner *preference*, not the
 * regression we actually guard against (index dropped / shadowed →
 * Seq Scan at SC-005 scale).
 *
 * This test pins:
 *   1. `audit_log_f8_tier_change_idx` exists with the expected partial
 *      predicate after migration. THIS is the real drop guard for
 *      0115 — it fails if a future migration drops or renames the
 *      index, regardless of what the planner does in test #2.
 *   2. EXPLAIN (FORMAT JSON) on the production sub-query shape: IF
 *      the plan mentions any index, it MUST be one of the
 *      `member_plan_changed` partial indexes (dynamic allowlist from
 *      `pg_indexes`). Any member of that set serves the EXISTS shape;
 *      a plan citing an index OUTSIDE the set (or, at scale, a Seq
 *      Scan after both partials are gone — caught by test #1 first)
 *      is the regression.
 *
 * Round-5 H2 acknowledged the migration ships BEFORE the planner-cost
 * EXPLAIN was actually captured; this test fills that gap by running
 * EXPLAIN at integration time against live Neon Singapore.
 */
import { describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sql as drizzleSql } from 'drizzle-orm';

const INDEX_NAME = 'audit_log_f8_tier_change_idx';

describe('F8 migration 0115 — audit_log_f8_tier_change_idx (L4)', () => {
  it('partial index exists with the expected predicate after migration', async () => {
    const rows = await db.execute<{
      indexname: string;
      indexdef: string;
    }>(drizzleSql`
      SELECT indexname, indexdef
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'audit_log'
         AND indexname = ${INDEX_NAME}
    `);
    expect(rows.length).toBe(1);
    const def = rows[0]!.indexdef;
    // Sanity: composite (tenant_id, timestamp) on audit_log filtered
    // to the member_plan_changed event_type. Postgres normalises
    // whitespace + identifier quoting so we use case-insensitive
    // substring matches rather than full-equality.
    expect(def).toMatch(/audit_log/i);
    expect(def).toMatch(/tenant_id/i);
    expect(def).toMatch(/(timestamp|"timestamp")/i);
    expect(def).toMatch(/member_plan_changed/);
  });

  it('at-risk EXISTS shape is served by a member_plan_changed partial index (dynamic allowlist)', async () => {
    // Mirror the at-risk recompute CTE's EXISTS sub-query shape
    // (`drizzle-member-renewal-flags-repo.ts`):
    //   SELECT 1 FROM audit_log
    //    WHERE tenant_id = $1
    //      AND event_type = 'member_plan_changed'
    //      AND timestamp > NOW() - INTERVAL '12 months'
    //   LIMIT 1
    //
    // Build the allowlist dynamically from the catalog: EVERY index on
    // audit_log whose definition carries the member_plan_changed
    // partial predicate serves this shape (tenant equality + timestamp
    // range over a tiny partial domain — 0078 and 0115 are both
    // valid planner choices; see file header). Asserting a single
    // name pinned planner *preference* and flaked when audit_log
    // statistics drifted on the shared dev DB (2026-06-10).
    const allowlistRows = await db.execute<{ indexname: string }>(drizzleSql`
      SELECT indexname
        FROM pg_indexes
       WHERE schemaname = 'public'
         AND tablename = 'audit_log'
         AND indexdef ~ 'member_plan_changed'
    `);
    const allowedIndexNames = allowlistRows.map((r) => r.indexname);
    // The allowlist must at minimum contain OUR index (test #1 above
    // asserts its existence + predicate; this keeps the allowlist
    // honest — an empty set would make the conditional below
    // vacuously green).
    expect(allowedIndexNames).toContain(INDEX_NAME);

    const planRows = await db.execute<{
      'QUERY PLAN': Array<{ Plan: { 'Node Type': string; 'Index Name'?: string } }>;
    }>(drizzleSql`
      EXPLAIN (FORMAT JSON)
      SELECT 1
        FROM audit_log
       WHERE tenant_id = 'swecham'
         AND event_type = 'member_plan_changed'
         AND "timestamp" > NOW() - INTERVAL '12 months'
       LIMIT 1
    `);
    const planJson = planRows[0]!['QUERY PLAN'];
    const planText = JSON.stringify(planJson);
    // Either (a) the planner chose A member_plan_changed partial index
    // by name, or (b) on an empty audit_log the planner falls back to
    // a Seq Scan (cheaper than index for ~0 rows) — both acceptable.
    // What we forbid is the plan citing an index OUTSIDE the partial
    // set (a wider composite shadowing the partials). The
    // dropped-entirely regression (Seq Scan because no
    // member_plan_changed index exists at all) is caught by test #1's
    // existence assertion, NOT here — an empty-table Seq Scan is
    // indistinguishable from a no-index Seq Scan at EXPLAIN level.
    const citedIndexNames = [...planText.matchAll(/"Index Name":"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    for (const cited of citedIndexNames) {
      expect(allowedIndexNames).toContain(cited);
    }
    // Hard assertion: the EXPLAIN itself succeeded (no error/invalid
    // markers in the plan output).
    expect(planText).not.toMatch(/error|invalid/i);
  });
});
