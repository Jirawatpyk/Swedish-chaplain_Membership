/**
 * F8 Phase 4 Wave I2b — Drizzle adapter for `MemberRenewalFlagsRepo`.
 *
 * Implements the F8-internal port `MemberRenewalFlagsRepo` against the
 * F3 `members` table. F3 OWNS the schema (Phase 2 Wave C migration
 * 0094 added `email_unverified` BOOLEAN + `email_unverified_at`
 * TIMESTAMPTZ); F8 OWNS the lifecycle:
 *
 *   - T090 detect-bounce-threshold (Wave I2d) → `setEmailUnverified`
 *   - T091 reset-email-unverified (this wave) → `clearEmailUnverified`
 *
 * Tenant isolation is enforced by F3's RLS policy on `members` —
 * every method wraps its query in `runInTenant(ctx, …)` which sets
 * `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant`.
 * NO explicit `WHERE tenant_id = ?` — the policy adds it automatically
 * (research.md § 7.1).
 *
 * Cross-module deep-import precedent: `drizzle-renewal-cycle-repo.ts`
 * line 26 imports F3's `members` schema for the LEFT JOIN to surface
 * `company_name`. This adapter follows the same convention.
 */
import { and, asc, desc, eq, exists, gte, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import type { TenantContext } from '@/modules/tenants';
import { members } from '@/modules/members/infrastructure/db/schema-members';
// Cross-module adapter→barrel import for F7's canonical quota-year
// helper (063 — single source of truth for the e-blast quota window;
// matches drizzle-at-risk-scorer.ts + countForMemberQuota).
import { currentQuotaYear } from '@/modules/broadcasts';
import { renewalCycles } from '../schema-renewal-cycles';
import { tierBucketDowngradePredicateSql } from './tier-bucket-ordinal-sql';
import type {
  MemberFlagToggleResult,
  MemberRenewalFlagsRepo,
  MemberRenewalFlagsMutationResult,
  SetBlockedFromAutoReactivationInput,
  SetRiskScoreInput,
  SetRiskScoreResult,
  ListAtRiskWidgetOpts,
  ListAtRiskWidgetResult,
  AtRiskWidgetMemberRow,
  BulkSetRiskScoreRow,
  AtRiskBatchFactorRow,
} from '../../application/ports/member-renewal-flags-repo';
import type { RiskBand } from '../../domain/value-objects/risk-band';

export function makeDrizzleMemberRenewalFlagsRepo(
  // RLS does the tenant binding via runInTenant at the use-case layer;
  // this adapter receives only the tx + memberId and writes via the
  // members table directly. The tenant param is reserved for future
  // safety assertions or per-tenant adapter caching (consumed by the
  // companion `WithTenant` factory below).
  _tenant: TenantContext,
): MemberRenewalFlagsRepo {
  return {
    async setEmailUnverified(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberRenewalFlagsMutationResult> {
      const txDb = tx as typeof db;
      // First read the prior state inside the same tx so the
      // `previouslyUnverified` answer reflects a consistent snapshot
      // even under concurrent writes (the read + write commit together).
      const priorRows = await txDb
        .select({ emailUnverified: members.emailUnverified })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previouslyUnverified: false, affectedRows: 0 };
      }
      const wasAlreadyUnverified = prior.emailUnverified;
      // Idempotent — if the flag is already TRUE, preserve the original
      // `email_unverified_at` timestamp (don't reset on each bounce).
      if (wasAlreadyUnverified) {
        return { previouslyUnverified: true, affectedRows: 1 };
      }
      const updated = await txDb
        .update(members)
        .set({
          emailUnverified: true,
          emailUnverifiedAt: new Date(),
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return {
        previouslyUnverified: false,
        affectedRows: updated.length,
      };
    },

    async clearEmailUnverified(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberRenewalFlagsMutationResult> {
      const txDb = tx as typeof db;
      // Read prior state for the previouslyUnverified flag.
      const priorRows = await txDb
        .select({ emailUnverified: members.emailUnverified })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previouslyUnverified: false, affectedRows: 0 };
      }
      const wasUnverified = prior.emailUnverified;
      // Always issue the UPDATE so `email_unverified_at` is cleared
      // even on the rare "row exists but flag already false" case
      // (defensive — a future code path that forgets to NULL the
      // timestamp would leave a stale `email_unverified_at`).
      const updated = await txDb
        .update(members)
        .set({
          emailUnverified: false,
          emailUnverifiedAt: null,
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return {
        previouslyUnverified: wasUnverified,
        affectedRows: updated.length,
      };
    },

    async setRenewalRemindersOptedOut(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ optedOut: members.renewalRemindersOptedOut })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      // Idempotent — preserve original opted-out timestamp on re-toggle.
      if (prior.optedOut) {
        return { previousValue: true, affectedRows: 1 };
      }
      const updated = await txDb
        .update(members)
        .set({
          renewalRemindersOptedOut: true,
          renewalRemindersOptedOutAt: new Date(),
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: false, affectedRows: updated.length };
    },

    async clearRenewalRemindersOptedOut(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ optedOut: members.renewalRemindersOptedOut })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      const wasOptedOut = prior.optedOut;
      const updated = await txDb
        .update(members)
        .set({
          renewalRemindersOptedOut: false,
          renewalRemindersOptedOutAt: null,
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: wasOptedOut, affectedRows: updated.length };
    },

    async setBlockedFromAutoReactivation(
      tx: unknown,
      _tenantId: string,
      input: SetBlockedFromAutoReactivationInput,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ blocked: members.blockedFromAutoReactivation })
        .from(members)
        .where(eq(members.memberId, input.memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      // Idempotent — preserve original block timestamp + actor on
      // double-block. The reason field stays as set originally; if a
      // different admin needs to update the reason they unblock + re-
      // block (audit captures the chain).
      if (prior.blocked) {
        return { previousValue: true, affectedRows: 1 };
      }
      const updated = await txDb
        .update(members)
        .set({
          blockedFromAutoReactivation: true,
          blockedFromAutoReactivationAt: new Date(),
          blockedFromAutoReactivationSetByUserId: input.actorUserId,
          blockedFromAutoReactivationReason: input.reason ?? null,
        })
        .where(eq(members.memberId, input.memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: false, affectedRows: updated.length };
    },

    async readBlockedFromAutoReactivation(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<boolean | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({ blocked: members.blockedFromAutoReactivation })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      return rows[0]?.blocked ?? null;
    },

    async readRenewalRemindersOptedOut(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<boolean | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({ optedOut: members.renewalRemindersOptedOut })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      return rows[0]?.optedOut ?? null;
    },

    async clearBlockedFromAutoReactivation(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ blocked: members.blockedFromAutoReactivation })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      const wasBlocked = prior.blocked;
      // Reset all four block-related columns atomically per migration
      // 0094's CHECK constraint (blocked=FALSE → all metadata NULL).
      const updated = await txDb
        .update(members)
        .set({
          blockedFromAutoReactivation: false,
          blockedFromAutoReactivationAt: null,
          blockedFromAutoReactivationSetByUserId: null,
          blockedFromAutoReactivationReason: null,
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return { previousValue: wasBlocked, affectedRows: updated.length };
    },

    /**
     * Phase 6 Wave B (T154) — write the at-risk score result onto F3
     * `members.risk_score_*` columns. Reads prior `risk_score_band` in
     * the same tx so the use-case can detect band crossings without an
     * extra round-trip; both reads + the UPDATE commit atomically.
     */
    async setRiskScore(
      tx: unknown,
      _tenantId: string,
      memberId: string,
      input: SetRiskScoreInput,
    ): Promise<SetRiskScoreResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ band: members.riskScoreBand })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousBand: null, affectedRows: 0 };
      }
      const previousBand = (prior.band as RiskBand | null) ?? null;
      const updated = await txDb
        .update(members)
        .set({
          riskScore: input.score,
          riskScoreBand: input.band,
          riskScoreFactors: input.factors,
          riskScoreLastComputedAt: new Date(input.computedAt),
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return { previousBand, affectedRows: updated.length };
    },

    /**
     * Phase 6 Wave C (T161) — list active member IDs for the weekly
     * at-risk recompute cron loop. Filters per FR-007a:
     *   - `members.status === 'active'`
     *   - EXISTS a `renewal_cycles` row for this member with status NOT
     *     IN ('lapsed', 'cancelled')
     *
     * Tenant-scoped via RLS (members + renewal_cycles both have
     * tenant_isolation policies). Ordered by `member_id ASC` for
     * deterministic batching.
     */
    async listActiveMemberIdsForAtRiskRecompute(
      tx: unknown,
      _tenantId: string,
      limit?: number,
    ): Promise<ReadonlyArray<string>> {
      const txDb = tx as typeof db;
      const baseQuery = txDb
        .select({ memberId: members.memberId })
        .from(members)
        .where(
          and(
            eq(members.status, 'active'),
            exists(
              txDb
                .select({ one: sql`1` })
                .from(renewalCycles)
                .where(
                  and(
                    eq(renewalCycles.memberId, members.memberId),
                    notInArray(renewalCycles.status, ['lapsed', 'cancelled']),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(members.memberId));
      const rows =
        limit !== undefined ? await baseQuery.limit(limit) : await baseQuery;
      return rows.map((r) => r.memberId);
    },

    /**
     * Phase 6 Wave G T159b — bulk-write all members' risk scores in
     * one round-trip via UPDATE … FROM jsonb_to_recordset(…). Hits
     * the FR-036 SLO budget (60s @ 5,000 members) by collapsing N
     * UPDATE round-trips into 1.
     */
    async bulkSetRiskScores(
      tx: unknown,
      _tenantId: string,
      rows: ReadonlyArray<BulkSetRiskScoreRow>,
      computedAt: Date,
    ): Promise<{ readonly affectedRows: number }> {
      if (rows.length === 0) return { affectedRows: 0 };
      const txDb = tx as typeof db;
      const payload = rows.map((r) => ({
        member_id: r.memberId,
        score: r.score,
        band: r.band,
        factors: r.factors,
      }));
      // postgres-js driver only accepts string/Buffer params (unlike node-postgres).
      const result = await txDb.execute(sql`
        UPDATE members AS m
        SET
          risk_score = src.score,
          risk_score_band = src.band,
          risk_score_factors = src.factors,
          risk_score_last_computed_at = ${computedAt.toISOString()}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS src(member_id uuid, score smallint, band text, factors jsonb)
        WHERE m.member_id = src.member_id
      `);
      return { affectedRows: (result as { count?: number }).count ?? rows.length };
    },

    /**
     * Phase 6 Wave G T159b — gather factor inputs for ALL active
     * members in one CTE round-trip. Joins: F4 invoices LATERAL
     * aggregate (overdue_count + last_paid_at), F2 membership_plans
     * (eblast_per_year benefit entitlement), F7 broadcasts LATERAL
     * count (e-blasts consumed by member in current year), F1
     * audit_log EXISTS (member_plan_changed events in last 12 months
     * indicating tier-downgrade per FR-029 line 8).
     *
     * 6 of 8 FR-029 factors implemented end-to-end against real data
     * (only F6 events_attended_12mo + events_attended_3mo +
     * cultural_ticket_quota stay stubbed — pending F6 EventCreate
     * integration).
     */
    async gatherAtRiskFactorsForTenant(
      tx: unknown,
      tenantId: string,
    ): Promise<ReadonlyArray<AtRiskBatchFactorRow>> {
      const txDb = tx as typeof db;
      // 063 correctness fix — compute the current quota year ONCE for the
      // batch (tenant timezone) and bind it into the e-blast LATERAL so
      // the per-quota-year window matches F7's canonical
      // countForMemberQuota + the single-member scorer.
      const quotaYear = currentQuotaYear(new Date(), env.tenant.timezone);
      const rows = await txDb.execute<{
        member_id: string;
        created_at: Date;
        last_activity_at: Date | null;
        prior_band: string | null;
        overdue_count: string;
        last_paid_at: Date | null;
        eblast_quota: string | null;
        eblast_consumed: string;
        tier_downgraded: boolean;
      }>(sql`
        SELECT
          m.member_id,
          m.created_at,
          m.last_activity_at,
          m.risk_score_band AS prior_band,
          COALESCE(inv.overdue_count, 0)::text AS overdue_count,
          inv.last_paid_at,
          (p.benefit_matrix->>'eblast_per_year')::text AS eblast_quota,
          COALESCE(eb.consumed, 0)::text AS eblast_consumed,
          EXISTS (
            SELECT 1
            FROM audit_log al
            JOIN membership_plans p_old
              ON p_old.tenant_id = al.tenant_id
              AND p_old.plan_id = al.payload->>'old_plan_id'
              -- Phase 6 review C3: regex-guarded cast so a malformed
              -- payload (non-numeric old_plan_year) for ONE member's
              -- audit row does not abort the whole CTE for the whole
              -- tenant. The row is silently treated as "no match" —
              -- equivalent to "not downgraded" for that audit entry.
              AND al.payload->>'old_plan_year' ~ '^[0-9]+$'
              AND p_old.plan_year = (al.payload->>'old_plan_year')::int
            JOIN membership_plans p_new
              ON p_new.tenant_id = al.tenant_id
              AND p_new.plan_id = al.payload->>'new_plan_id'
              AND al.payload->>'new_plan_year' ~ '^[0-9]+$'
              AND p_new.plan_year = (al.payload->>'new_plan_year')::int
            WHERE al.event_type = 'member_plan_changed'
              AND al.tenant_id = ${tenantId}
              AND al.payload->>'member_id' = m.member_id::text
              AND al.timestamp > NOW() - INTERVAL '12 months'
              -- 063 — bucket-ordinal downgrade test via the shared
              -- fragment (derived from the Domain TIER_BUCKETS tuple) so
              -- the single-member + batch scorers cannot drift. A
              -- downgrade = lower NEW-bucket ordinal than OLD-bucket
              -- ordinal (a move to a lower tier bucket, not a fee cut).
              AND ${sql.raw(
                tierBucketDowngradePredicateSql(
                  'p_new.renewal_tier_bucket',
                  'p_old.renewal_tier_bucket',
                ),
              )}
          ) AS tier_downgraded
        FROM members m
        LEFT JOIN membership_plans p
          ON p.tenant_id = m.tenant_id
          AND p.plan_id = m.plan_id
          AND p.plan_year = m.plan_year
        LEFT JOIN LATERAL (
          SELECT
            count(*) FILTER (
              WHERE status = 'issued'
                AND created_at < NOW() - INTERVAL '30 days'
            ) AS overdue_count,
            MAX(paid_at) AS last_paid_at
          FROM invoices
          -- Phase 6 review I7 — explicit tenant_id filter as
          -- defence-in-depth atop RLS. Constitution Principle I 2-layer
          -- rule: if RLS bind is misconfigured, the filter still scopes.
          WHERE tenant_id = m.tenant_id AND member_id = m.member_id
        ) inv ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS consumed
          FROM broadcasts b
          -- Phase 6 review I7 — explicit tenant_id filter (defence-in-depth).
          WHERE b.tenant_id = m.tenant_id
            AND b.requested_by_member_id = m.member_id
            -- 063 correctness fix — count the e-blast quota slots the
            -- member ORIGINATED for the CURRENT quota year, matching F7's
            -- canonical countForMemberQuota (drizzle-broadcasts-repo.ts):
            -- USED (sent rows whose quota_year_consumed = the current
            -- quota year) plus RESERVED (submitted/approved/
            -- failed_to_dispatch rows, which per the broadcasts schema
            -- CHECK have quota_year_consumed IS NULL and reserve against
            -- the current year). The prior rolling-12mo
            -- quota_consumed_at window (a) used the wrong window — quota
            -- is per-quota-YEAR, not rolling — and (b) used a status set
            -- (sent,sending,approved) that diverged from both F7's
            -- canonical set and the single-member scorer. quotaYear is
            -- computed once per batch in the tenant timezone and bound as
            -- a param so the year boundary matches how F7 wrote the row.
            -- 'sending' intentionally excluded: it has left the reserved
            -- set and will imminently land in 'sent' or 'failed_to_dispatch';
            -- counting it here would double-count against the quota cap.
            AND (
              (b.status = 'sent' AND b.quota_year_consumed = ${quotaYear})
              OR b.status IN ('submitted', 'approved', 'failed_to_dispatch')
            )
        ) eb ON true
        WHERE m.status = 'active'
          AND EXISTS (
            SELECT 1 FROM renewal_cycles c
            WHERE c.member_id = m.member_id
              AND c.status NOT IN ('lapsed', 'cancelled')
          )
        ORDER BY m.member_id
      `);
      // postgres-js returns timestamptz as either Date or ISO string
      // depending on column metadata; normalise via constructor.
      const toIso = (v: Date | string | null | undefined): string | null => {
        if (v == null) return null;
        if (v instanceof Date) return v.toISOString();
        return new Date(v).toISOString();
      };
      return rows.map((r) => {
        const eblastQuota =
          r.eblast_quota != null
            ? Number.parseInt(r.eblast_quota, 10) || 0
            : 0;
        const eblastConsumed = Number.parseInt(r.eblast_consumed, 10) || 0;
        const eblastQuotaPctUsed =
          eblastQuota > 0 ? (eblastConsumed / eblastQuota) * 100 : null;
        return {
          memberId: r.member_id,
          memberCreatedAt: toIso(r.created_at) ?? new Date().toISOString(),
          lastActivityAtIso: toIso(r.last_activity_at),
          priorRiskBand: (r.prior_band as RiskBand | null) ?? null,
          invoicesOverdueCount: Number.parseInt(r.overdue_count, 10) || 0,
          lastPaidAtIso: toIso(r.last_paid_at),
          eblastQuotaPctUsed,
          tierDowngradedLast12Months: r.tier_downgraded,
        };
      });
    },

    /**
     * Phase 6 Wave D (T163) — paginated read for the at-risk widget.
     * Two queries inside the supplied tx:
     *   1. Page query — filtered + sorted + cursor + limit
     *   2. Summary query — aggregate band counts (single round-trip
     *      via FILTER(WHERE …) per band)
     * Both share the WHERE-clause tail (`risk_score >= 50` + snoozed
     * filter) so the partial index `members_at_risk_idx` (migration
     * 0094) covers them.
     */
    async listAtRiskWidgetMembers(
      tx: unknown,
      _tenantId: string,
      opts: ListAtRiskWidgetOpts,
    ): Promise<ListAtRiskWidgetResult> {
      const txDb = tx as typeof db;
      const limit = Math.min(50, Math.max(1, opts.limit ?? 20));

      // Cursor format: `${score}|${memberId}` — opaque to caller.
      let cursorScore: number | null = null;
      let cursorMemberId: string | null = null;
      if (opts.cursor) {
        const sep = opts.cursor.indexOf('|');
        if (sep > 0) {
          const score = Number.parseInt(opts.cursor.slice(0, sep), 10);
          if (Number.isFinite(score)) {
            cursorScore = score;
            cursorMemberId = opts.cursor.slice(sep + 1);
          }
        }
      }

      const baseWhere = and(
        // Phase 6 review I6 — filter archived members from the widget.
        // Archive does not currently clear risk_score (kept for forensic
        // history), so without this filter an archived "at-risk" member
        // would still surface in the widget — admin would click Snooze
        // on a phantom row.
        eq(members.status, 'active'),
        gte(members.riskScore, 50),
        or(
          isNull(members.riskSnoozedUntil),
          lt(members.riskSnoozedUntil, sql`NOW()`),
        ),
        ...(opts.band ? [eq(members.riskScoreBand, opts.band)] : []),
        ...(cursorScore !== null && cursorMemberId !== null
          ? [
              or(
                lt(members.riskScore, cursorScore),
                and(
                  eq(members.riskScore, cursorScore),
                  sql`${members.memberId} > ${cursorMemberId}`,
                ),
              )!,
            ]
          : []),
      );

      const pageRows = await txDb
        .select({
          memberId: members.memberId,
          companyName: members.companyName,
          riskScore: members.riskScore,
          riskScoreBand: members.riskScoreBand,
          riskScoreFactors: members.riskScoreFactors,
          riskScoreLastComputedAt: members.riskScoreLastComputedAt,
          riskSnoozedUntil: members.riskSnoozedUntil,
        })
        .from(members)
        .where(baseWhere)
        .orderBy(desc(members.riskScore), asc(members.memberId))
        .limit(limit + 1); // +1 to detect more-pages

      const hasMore = pageRows.length > limit;
      const items: AtRiskWidgetMemberRow[] = pageRows
        .slice(0, limit)
        .filter(
          (r): r is typeof r & { riskScore: number; riskScoreBand: string } =>
            r.riskScore !== null && r.riskScoreBand !== null,
        )
        .map((r) => ({
          memberId: r.memberId,
          companyName: r.companyName,
          riskScore: r.riskScore,
          riskScoreBand: r.riskScoreBand as
            | 'warning'
            | 'at-risk'
            | 'critical',
          riskScoreFactors:
            (r.riskScoreFactors as Record<string, unknown> | null) ?? null,
          riskScoreLastComputedAt:
            r.riskScoreLastComputedAt?.toISOString() ?? null,
          riskSnoozedUntil: r.riskSnoozedUntil?.toISOString() ?? null,
        }));

      const lastItem = items[items.length - 1];
      const nextCursor =
        hasMore && lastItem
          ? `${lastItem.riskScore}|${lastItem.memberId}`
          : null;

      // Summary — one query with FILTER aggregates per band.
      const summaryRows = await txDb.execute<{
        warning: string | null;
        at_risk: string | null;
        critical: string | null;
      }>(sql`
        SELECT
          count(*) FILTER (WHERE risk_score_band = 'warning') AS warning,
          count(*) FILTER (WHERE risk_score_band = 'at-risk') AS at_risk,
          count(*) FILTER (WHERE risk_score_band = 'critical') AS critical
        FROM members
        WHERE status = 'active'  -- Phase 6 review I6 (archive cascade)
          AND risk_score >= 50
          AND (risk_snoozed_until IS NULL OR risk_snoozed_until < NOW())
      `);
      const summaryRow = summaryRows[0];
      const toInt = (v: string | number | null | undefined): number => {
        if (v === null || v === undefined) return 0;
        return typeof v === 'number' ? v : Number.parseInt(v, 10) || 0;
      };
      return {
        items,
        nextCursor,
        summary: {
          warning: toInt(summaryRow?.warning),
          atRisk: toInt(summaryRow?.at_risk),
          critical: toInt(summaryRow?.critical),
        },
      };
    },

    /**
     * Phase 6 Wave B (T155) — set `members.risk_snoozed_until` per
     * FR-032. Adapter persists ISO timestamp via Date conversion;
     * `previousValue` field of MemberFlagToggleResult is repurposed to
     * `was-snoozed-active-now` (true ⇒ a snooze was already active at
     * call time). Adapter trusts the use-case to validate the
     * snooze-duration enum (7|30|90).
     */
    async setRiskSnoozedUntil(
      tx: unknown,
      _tenantId: string,
      memberId: string,
      snoozedUntil: string,
    ): Promise<MemberFlagToggleResult> {
      const txDb = tx as typeof db;
      const priorRows = await txDb
        .select({ snoozedUntil: members.riskSnoozedUntil })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const prior = priorRows[0];
      if (!prior) {
        return { previousValue: false, affectedRows: 0 };
      }
      const wasSnoozedActive =
        prior.snoozedUntil !== null &&
        prior.snoozedUntil.getTime() > Date.now();
      const updated = await txDb
        .update(members)
        .set({ riskSnoozedUntil: new Date(snoozedUntil) })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return {
        previousValue: wasSnoozedActive,
        affectedRows: updated.length,
      };
    },
  };
}

/**
 * Convenience wrapper that opens a `runInTenant` block for callers
 * that don't already have a tx (e.g., tests + ad-hoc scripts). The
 * use-case path always supplies an outer tx via `runInTenant` →
 * tx parameter, so this wrapper is rarely needed in production code.
 */
export function makeDrizzleMemberRenewalFlagsRepoWithTenant(
  tenant: TenantContext,
): MemberRenewalFlagsRepo & {
  clearEmailUnverifiedInTenant: (
    memberId: string,
  ) => Promise<MemberRenewalFlagsMutationResult>;
} {
  const base = makeDrizzleMemberRenewalFlagsRepo(tenant);
  return {
    ...base,
    async clearEmailUnverifiedInTenant(memberId: string) {
      return runInTenant(tenant, async (tx) =>
        base.clearEmailUnverified(tx, tenant.slug, memberId),
      );
    },
  };
}
