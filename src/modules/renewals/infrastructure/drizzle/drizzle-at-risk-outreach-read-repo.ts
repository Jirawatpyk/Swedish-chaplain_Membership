/**
 * F8 Phase 4 Wave I2a — Drizzle adapter for `AtRiskOutreachReadRepo`.
 *
 * Implements the F8 read-only port `AtRiskOutreachReadRepo` against
 * the `at_risk_outreach` table (Wave C migration 0090). Tenant
 * isolation is enforced by Postgres RLS+FORCE — every method wraps
 * its query in `runInTenant(ctx, …)` which sets `SET LOCAL ROLE
 * chamber_app` + `SET LOCAL app.current_tenant`. NO explicit
 * `WHERE tenant_id = ?` — the policy adds it automatically.
 *
 * Phase 4 (US2) directly exercises:
 *   - `hasOutreachWithinDays` — per-member pause-check called by the
 *     daily dispatcher cron (FR-033 / 7-day pause after outreach).
 *
 * The full mutating surface (record outreach, list-for-member-timeline)
 * ships with US4 (Phase 6 — at-risk widget). This adapter is read-only.
 */
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { atRiskOutreach } from '../schema-at-risk-outreach';
import type {
  AtRiskOutreachReadRepo,
  OutreachWithinWindowResult,
} from '../../application/ports/at-risk-outreach-read-repo';

export function makeDrizzleAtRiskOutreachReadRepo(
  tenant: TenantContext,
): AtRiskOutreachReadRepo {
  return {
    async hasOutreachWithinDays(
      _tenantId: string,
      memberId: string,
      withinDays: number,
    ): Promise<OutreachWithinWindowResult> {
      // Reject unsafe values — caller already type-narrowed but defence
      // in depth against a future regression that bypasses the use-case
      // input schema. `withinDays` is interpolated into a `NOW() -
      // INTERVAL` expression which is parameterised but the value MUST
      // be a positive finite integer to prevent a DoS-grade query.
      if (
        !Number.isFinite(withinDays) ||
        withinDays <= 0 ||
        !Number.isInteger(withinDays) ||
        withinDays > 365
      ) {
        throw new Error(
          `hasOutreachWithinDays: withinDays must be an integer in [1, 365]; got ${withinDays}`,
        );
      }
      return runInTenant(tenant, async (tx) => {
        // Most-recent outreach inside the window. Returns up to 1 row;
        // null result means `hasOutreach=false`.
        const rows = await tx
          .select({ createdAt: atRiskOutreach.createdAt })
          .from(atRiskOutreach)
          .where(
            and(
              eq(atRiskOutreach.memberId, memberId),
              sql`${atRiskOutreach.createdAt} >= NOW() - (${withinDays}::int * INTERVAL '1 day')`,
            ),
          )
          .orderBy(sql`${atRiskOutreach.createdAt} DESC`)
          .limit(1);
        const row = rows[0];
        if (!row) return { hasOutreach: false, latestAt: null };
        return {
          hasOutreach: true,
          latestAt: row.createdAt.toISOString(),
        };
      });
    },
  };
}
