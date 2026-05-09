/**
 * F8 Phase 7 T179 — Drizzle adapter for `TierUpgradeEvalCandidateRepo`.
 *
 * Composite-query reader for the weekly tier-upgrade-evaluate cron.
 * Joins `members` × `membership_plans` × `renewal_cycles` × `invoices`
 * to materialise per-member upgrade-eval candidates with the four
 * fields the use-case's decision tree needs:
 *
 *   - currentPlanId, currentRenewalTierBucket
 *   - turnoverThb (nullable)
 *   - paidInvoiceVolume12mThb (sum of paid invoice totals last 365d)
 *
 * Filters per FR-007a "active member" canonical:
 *   - members.status='active'
 *   - EXISTS (renewal_cycle for this member with status NOT IN
 *             ('lapsed','cancelled'))
 *
 * Cursor-paginated by `(memberId ASC)` for deterministic batching.
 *
 * Pure Infrastructure — only `@/lib/db` + sibling-module barrel reads.
 */
import { and, eq, sql, asc, gt, exists } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans';
import { renewalCycles } from '../schema-renewal-cycles';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { parseTierBucket } from '../../domain/value-objects/tier-bucket';
import type {
  TierUpgradeEvalCandidate,
  TierUpgradeEvalCandidateListArgs,
  TierUpgradeEvalCandidatePage,
  TierUpgradeEvalCandidateRepo,
} from '../../application/ports/tier-upgrade-eval-candidate-repo';

export function makeDrizzleTierUpgradeEvalCandidateRepo(
  tenant: TenantContext,
): TierUpgradeEvalCandidateRepo {
  return {
    async list(
      tenantId: string,
      args: TierUpgradeEvalCandidateListArgs,
    ): Promise<TierUpgradeEvalCandidatePage> {
      return runInTenant(tenant, async (tx) => {
        const txDb = tx as unknown as typeof db;
        const cutoff = new Date(
          Date.now() - 365 * 24 * 60 * 60 * 1000,
        );

        // Two-step: first list active-member candidates with current
        // plan join; then per-page compute the 12m paid-invoice-volume
        // aggregate. Single round-trip via a CTE-like subquery.
        const limit = Math.min(Math.max(args.pageSize, 1), 1000);
        const cursor = args.cursor ?? '';

        const rows = await txDb
          .select({
            tenantId: members.tenantId,
            memberId: members.memberId,
            currentPlanId: members.planId,
            renewalTierBucket: membershipPlans.renewalTierBucket,
            turnoverThb: members.turnoverThb,
            // Aggregate sum of paid-invoice satang in the last 365d for
            // this member; coalesce NULL to 0 when no paid invoices.
            paidInvoiceVolumeSatang: sql<bigint>`COALESCE((
              SELECT SUM(${invoices.totalSatang})::bigint
              FROM ${invoices}
              WHERE ${invoices.memberId} = ${members.memberId}
                AND ${invoices.tenantId} = ${members.tenantId}
                AND ${invoices.status} = 'paid'
                AND ${invoices.paidAt} >= ${cutoff.toISOString()}::timestamptz
            ), 0::bigint)`.as('paid_invoice_volume_satang'),
          })
          .from(members)
          .innerJoin(
            membershipPlans,
            and(
              eq(members.tenantId, membershipPlans.tenantId),
              eq(members.planId, membershipPlans.planId),
              eq(members.planYear, membershipPlans.planYear),
            ),
          )
          .where(
            and(
              eq(members.status, 'active'),
              cursor.length > 0
                ? gt(members.memberId, cursor)
                : sql`TRUE`,
              exists(
                txDb
                  .select({ one: sql`1` })
                  .from(renewalCycles)
                  .where(
                    and(
                      eq(renewalCycles.tenantId, members.tenantId),
                      eq(renewalCycles.memberId, members.memberId),
                      sql`${renewalCycles.status} NOT IN ('lapsed','cancelled')`,
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(members.memberId))
          .limit(limit + 1);

        void tenantId; // RLS already scopes; param kept for adapter symmetry.

        // Phase 7 review-fix I-TYPE-1: narrow `renewal_tier_bucket` to
        // the typed `TierBucket` union. Rows whose bucket value is
        // unparseable are dropped + warn-logged so a DB drift cannot
        // silently bypass the eligibility decision tree.
        const items: TierUpgradeEvalCandidate[] = [];
        for (const row of rows.slice(0, limit)) {
          const bucketParse = parseTierBucket(row.renewalTierBucket);
          if (!bucketParse.ok) {
            logger.warn(
              {
                tenantId: row.tenantId,
                memberId: row.memberId,
                rawBucket: row.renewalTierBucket,
              },
              '[tier-upgrade-eval-candidate] dropping member with unparseable renewal_tier_bucket',
            );
            continue;
          }
          items.push({
            tenantId: row.tenantId,
            memberId: row.memberId,
            currentPlanId: row.currentPlanId,
            currentRenewalTierBucket: bucketParse.value,
            turnoverThb: row.turnoverThb,
            // satang → THB (1 THB = 100 satang).
            paidInvoiceVolume12mThb:
              Number(row.paidInvoiceVolumeSatang ?? 0n) / 100,
          });
        }
        const nextCursor =
          rows.length > limit ? rows[limit]!.memberId : null;
        return { items, nextCursor };
      });
    },
  };
}
