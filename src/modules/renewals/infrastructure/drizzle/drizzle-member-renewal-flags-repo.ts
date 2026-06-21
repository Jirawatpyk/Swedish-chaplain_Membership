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
 * Tenant isolation: most tables (members, membership_plans, renewal_*,
 * broadcasts) use strict isolating RLS policies — `runInTenant` SET LOCAL
 * is sufficient and NO explicit `WHERE tenant_id = ?` is required for them.
 * However, `audit_log` uses a PERMISSIVE policy where rows with NULL
 * tenant_id (F1 identity events, migration 0007) remain visible to every
 * tenant context. Therefore any `audit_log` query in this file MUST include
 * an explicit `al.tenant_id = ${tenantId}` predicate — it is load-bearing,
 * not optional. A future `audit_log` query added here MUST carry the same
 * explicit filter. (Mirrors the corrected header in drizzle-at-risk-scorer.ts
 * — same root cause.)
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
// the at-risk usage count uses the SAME year fence as F9's benefit-usage
// `used` (computeQuotaCounter.used) + the single-member scorer
// drizzle-at-risk-scorer.ts).
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

    /**
     * COMP-1 L3 — single-round-trip read of BOTH reactivation guards
     * (`blocked_from_auto_reactivation` + GDPR-erased state) for the F4
     * invoice-paid hot path. Folds two separate SELECTs against the SAME
     * `members` row into one, so the payment-confirmation callback issues one
     * read instead of two.
     *
     * Why both guards are needed: the scrub nulls the block reason / provenance
     * (`set_by_user_id`), and the 0094 consistency CHECK forbids `blocked=TRUE`
     * once that provenance is gone, so erasure forces the flag back to FALSE. A
     * paid lapsed cycle for an erased member must therefore be detected via
     * `erased_at` and routed to the admin-hold path instead of silently auto-
     * reactivating an anonymised tombstone. `null` ⇒ the member row is not
     * visible (RLS-hidden / absent). Threads the caller's `tx` (tenant-scoped)
     * — never the global db.
     */
    async readReactivationGuardsInTx(
      tx: unknown,
      _tenantId: string,
      memberId: string,
    ): Promise<{ readonly blocked: boolean; readonly erased: boolean } | null> {
      const txDb = tx as typeof db;
      const rows = await txDb
        .select({
          blocked: members.blockedFromAutoReactivation,
          erasedAt: members.erasedAt,
        })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const row = rows[0];
      if (row === undefined) return null;
      return { blocked: row.blocked, erased: row.erasedAt !== null };
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
      // COMP-1 R3 — re-check `erased_at IS NULL` at WRITE time (not just at
      // the candidate-LIST queries). A member erased AFTER candidate-listing
      // but BEFORE this write would otherwise get the scrubbed risk columns
      // re-populated, re-leaking the quasi-identifiers `scrubPiiInTx` NULLed.
      // The guard makes the UPDATE a no-op (affectedRows 0) on a tombstone —
      // the same shape the caller already tolerates for an absent/RLS-hidden
      // member (`previousBand: null, affectedRows: 0`).
      const updated = await txDb
        .update(members)
        .set({
          riskScore: input.score,
          riskScoreBand: input.band,
          riskScoreFactors: input.factors,
          riskScoreLastComputedAt: new Date(input.computedAt),
        })
        .where(and(eq(members.memberId, memberId), isNull(members.erasedAt)))
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
            // COMP-1 H4 — never re-score a GDPR-erased member (erasure keeps
            // `status` + NULLs risk_score, stamps `erased_at`).
            isNull(members.erasedAt),
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
    ): Promise<{
      readonly affectedRows: number;
      readonly writtenMemberIds: ReadonlyArray<string>;
    }> {
      if (rows.length === 0) return { affectedRows: 0, writtenMemberIds: [] };
      const txDb = tx as typeof db;
      const payload = rows.map((r) => ({
        member_id: r.memberId,
        score: r.score,
        band: r.band,
        factors: r.factors,
      }));
      // postgres-js driver only accepts string/Buffer params (unlike node-postgres).
      //
      // COMP-1 (companion to R3) — `RETURNING m.member_id` surfaces exactly
      // which member rows the UPDATE actually touched. The `erased_at IS NULL`
      // guard below silently skips a member erased between candidate-listing
      // and this write; returning the written ids lets the use-case gate its
      // per-member `at_risk_score_recomputed` audit on the ACTUAL write set
      // (no spurious "recompute succeeded" audit for a write-skipped tombstone).
      const result = await txDb.execute<{ member_id: string }>(sql`
        UPDATE members AS m
        SET
          risk_score = src.score,
          risk_score_band = src.band,
          risk_score_factors = src.factors,
          risk_score_last_computed_at = ${computedAt.toISOString()}::timestamptz
        FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          AS src(member_id uuid, score smallint, band text, factors jsonb)
        WHERE m.member_id = src.member_id
          -- COMP-1 R3 — per-row WRITE-time guard: never re-populate the
          -- scrubbed risk columns on a member erased between candidate-
          -- listing and this bulk write (TOCTOU re-leak of the quasi-
          -- identifiers scrubPiiInTx NULLed). An erased member in the batch
          -- is silently skipped; the RETURNING set reflects only live rows.
          AND m.erased_at IS NULL
        RETURNING m.member_id
      `);
      // postgres-js returns the RETURNING rows as an iterable result set; map
      // to the written member ids. The count is derived from the returned rows
      // so it cannot drift from `writtenMemberIds.length`.
      const writtenMemberIds = Array.from(result).map((r) => r.member_id);
      return {
        affectedRows: writtenMemberIds.length,
        writtenMemberIds,
      };
    },

    /**
     * Phase 6 Wave G T159b — gather factor inputs for ALL active
     * members in one CTE round-trip. Joins: F4 invoices LATERAL
     * aggregate (overdue_count + last_paid_at), F2 membership_plans
     * (eblast_per_year benefit entitlement), F7 broadcasts LATERAL
     * count (e-blasts the member ORIGINATED + SENT in the current quota
     * year — F9 benefit-usage `used`, NOT F7's enforcement count; see the
     * #8 note in the LATERAL below), F1 audit_log EXISTS
     * (member_plan_changed events in last 12 months indicating
     * tier-downgrade per FR-029 line 8).
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
              -- Phase 6 review C3: CASE-guarded cast so a malformed
              -- payload (non-numeric old_plan_year) for ONE member's
              -- audit row does not abort the whole CTE for the whole
              -- tenant. The cast lives inside the THEN branch, so the
              -- regex provably short-circuits BEFORE the int cast runs.
              -- An "AND regex AND cast=..." pattern does NOT guarantee
              -- this: Postgres may reorder AND clauses and crash with
              -- invalid-input-syntax-for-type-integer. A non-matching
              -- year yields NULL, so p_old.plan_year = NULL is NULL (not
              -- true) and the row is silently treated as "no match"
              -- (= "not downgraded") -- no crash, no false downgrade.
              AND p_old.plan_year = CASE
                    WHEN al.payload->>'old_plan_year' ~ '^[0-9]+$'
                    THEN (al.payload->>'old_plan_year')::int
                  END
            JOIN membership_plans p_new
              ON p_new.tenant_id = al.tenant_id
              AND p_new.plan_id = al.payload->>'new_plan_id'
              AND p_new.plan_year = CASE
                    WHEN al.payload->>'new_plan_year' ~ '^[0-9]+$'
                    THEN (al.payload->>'new_plan_year')::int
                  END
            WHERE al.event_type = 'member_plan_changed'
              -- Load-bearing: audit_log has a PERMISSIVE RLS policy; NULL-
              -- tenant F1 rows are cross-tenant-visible. This predicate is
              -- not defence-in-depth — it is REQUIRED for correct isolation.
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
            -- 063 axis fix (#3) — count the e-blast slots the member
            -- ORIGINATED (requested_by_member_id), not received. The prior
            -- rolling-12mo quota_consumed_at window used the wrong window
            -- (quota is per-quota-YEAR, not rolling) and a status set
            -- (sent,sending,approved) that diverged from the single-member
            -- scorer.
            --
            -- 063 usage-notion refinement (#8) — the at-risk ENGAGEMENT
            -- factor counts USAGE = F9 benefit-usage used (quota CONSUMED
            -- THIS quota year), matching computeQuotaCounter(...).counter.used
            -- (= countForMemberQuota.sent, the year-fenced consumed bucket).
            -- This intentionally DIVERGES from F7's quota-ENFORCEMENT count
            -- (which also includes the reserved bucket): enforcement must
            -- refuse a send while a slot is in-flight, but engagement asks
            -- whether the benefit was actually delivered THIS year.
            --
            -- BOTH 'sent' AND 'partial_delivery_accepted' consume the slot
            -- (schema CHECK broadcasts_quota_year_only_on_sent stamps
            -- quota_year_consumed for BOTH; FR-008c). Counting only 'sent'
            -- UNDERCOUNTS usage for a member who partial-accepted, which
            -- falsely FIRES the +15 risk factor for someone who did send.
            --
            -- Reserved rows (submitted/approved/failed_to_dispatch) are
            -- DROPPED here. They carry quota_year_consumed IS NULL (schema
            -- CHECK broadcasts_quota_year_only_on_sent), so they have NO
            -- year fence. NOTE: failed_to_dispatch RELEASES the quota slot
            -- (Design D1, 2026-06-21); this query counts only consumed rows
            -- regardless, so it is unaffected by D1. Counting reserved would
            -- inflate this year's usage, push pct >= 30, and silently
            -- SUPPRESS the +15 risk factor for a disengaged member (#8).
            -- Counting only consumed-this-year cannot leak a stale prior-year
            -- slot. quotaYear is computed once per batch in the tenant
            -- timezone and bound as a param so the year boundary matches
            -- how F7 wrote the row.
            AND b.status IN ('sent', 'partial_delivery_accepted')
            AND b.quota_year_consumed = ${quotaYear}
        ) eb ON true
        WHERE m.status = 'active'
          -- COMP-1 H4 — exclude GDPR-erased members from the at-risk batch
          -- recompute (erasure keeps status, stamps erased_at).
          AND m.erased_at IS NULL
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
        // COMP-1 H4 — also exclude GDPR-erased members. Erasure NULLs
        // risk_score (so `>= 50` already drops them), but keep this filter
        // explicit + consistent with the page/summary pair below.
        isNull(members.erasedAt),
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
          AND erased_at IS NULL  -- COMP-1 H4 (GDPR-erased excluded)
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
