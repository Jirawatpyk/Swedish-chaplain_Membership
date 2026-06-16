/**
 * F8 Phase 6 Wave G T159b · Batched at-risk recompute use-case.
 *
 * Performance-optimised cron path that processes ALL active members in
 * one tenant in 4 round-trips total (vs 6× per member in the per-
 * member computeAtRiskScore use-case). Hits the FR-036 + SC-005 SLO
 * (60s @ 5,000 members) on production-equivalent infra:
 *
 *   1. tenant_renewal_settings findByTenant — 1 round-trip
 *   2. gatherAtRiskFactorsForTenant CTE — 1 round-trip
 *      (instead of 5,000 × 2 queries)
 *   3. bulkSetRiskScores via UPDATE … FROM jsonb_to_recordset — 1 round-trip
 *   4. bulkEmitInTx INSERT … VALUES (multi-row) — 1 round-trip
 *
 * Per-member fault isolation is preserved at the in-memory loop: any
 * thrown exception during Domain compute is caught + skipped + counted
 * in `members_failed`. The per-tenant cron route emits a single
 * `at_risk_compute_partial_failure` audit per pass (already wired).
 *
 * Companion to `compute-at-risk-score.ts` (Wave B T154 — per-member
 * use-case for admin-triggered single-member recomputes). The per-
 * tenant cron route (T161) calls THIS batched function instead of
 * looping the per-member use-case to meet SLO budget.
 *
 * Pure Application layer — uses port interfaces only; no ORM / schema
 * imports per Constitution Principle III. The bulk SQL lives in the
 * Drizzle adapter for `MemberRenewalFlagsRepo.bulkSetRiskScores` +
 * `gatherAtRiskFactorsForTenant` + `RenewalAuditEmitter.bulkEmitInTx`.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { computeAtRiskScore as computeAtRiskScorePure } from '../../domain/at-risk-score';
import type {
  AtRiskFactors,
  AtRiskScoreResult,
} from '../../domain/at-risk-score';
import type { RiskBand } from '../../domain/value-objects/risk-band';
import type {
  F8AuditEvent,
  F8AuditEventType,
} from '../ports/renewal-audit-emitter';
import type {
  AtRiskBatchFactorRow,
  BulkSetRiskScoreRow,
} from '../ports/member-renewal-flags-repo';
// Type-only — runtime no-op brand cast (Constitution Principle III).
import type { MemberId } from '@/modules/members';
import { parseInput } from './_lib/parse-input';

export const recomputeAtRiskScoresBatchInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  // Round-5 review-finding H5: optional injected clock so test runs
  // pin determinism + production callers (cron coord) can pass the
  // request-time clock so `computedAt` aligns with the audit row's
  // `timestamp` (no drift mid-CTE under slow plans). Mirrors the
  // R4-W1 fix in `processTimeout` (`reconcile-pending-reactivations.ts:368`).
  // Default: wall-clock `() => new Date()` at use-case entry.
  now: z.date().optional(),
});

export type RecomputeAtRiskScoresBatchInput = z.infer<
  typeof recomputeAtRiskScoresBatchInputSchema
>;

export interface RecomputeAtRiskScoresBatchOutput {
  readonly membersTotal: number;
  readonly membersRecomputed: number;
  readonly membersSkippedBelowTenure: number;
  readonly membersFailed: number;
  readonly durationMs: number;
}

export type RecomputeAtRiskScoresBatchError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

/**
 * Numeric ordering of bands for FR-031 UP-only threshold-crossed
 * detection. Down-crossings are silent.
 */
const BAND_ORDER: Readonly<Record<RiskBand, number>> = {
  healthy: 0,
  warning: 1,
  'at-risk': 2,
  critical: 3,
};

interface ComputedRow {
  readonly memberId: string;
  readonly result: AtRiskScoreResult;
  readonly priorBand: RiskBand | null;
}

export async function recomputeAtRiskScoresBatch(
  deps: RenewalsDeps,
  rawInput: RecomputeAtRiskScoresBatchInput,
  /**
   * Optional external transaction. When the cron route holds a per-tenant
   * advisory_xact_lock in its own runInTenant block (Phase 6 review C1),
   * it passes that tx so the lock + the recompute work commit atomically.
   * When undefined, the use-case opens its own runInTenant.
   */
  externalTx?: import('@/lib/db').TenantTx,
): Promise<
  Result<
    RecomputeAtRiskScoresBatchOutput,
    RecomputeAtRiskScoresBatchError
  >
> {
  const inputResult = parseInput(
    recomputeAtRiskScoresBatchInputSchema,
    rawInput,
  );
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const startedAt = Date.now();

  // R4-W5 (staff-review-2026-05-09): tenant settings read MUST execute
  // inside the same `runInTenant(externalTx, ...)` block as the CTE
  // compute so they share the per-tenant advisory lock — admin
  // mutating `minTenureDaysForAtRisk` mid-cron must NOT cause settings
  // drift between read-time and CTE-compute-time. Single-row read; no
  // latency cost. Hoisted into `work` below.
  //
  // PR #24 review-fix — F6 availability read folded INTO the lock too.
  // Previously read outside `runInTenant`, leaving a window where a
  // tenant flipping F6 mid-cron could observe inconsistent state
  // between this read and the CTE-compute-time. F7 currently stubs
  // `isAvailable() === false`, so the prior placement was inert; the
  // move here is a forward-compat hardening matching the R4-W5
  // settings hoist rationale.
  // Round-5 H5: honour injected clock when provided; default to
  // wall-clock new Date(). Pinning here means `computedAt`,
  // `nowMs`, and downstream FR-035 min-tenure cutoff all reference
  // the same instant — no drift mid-tx.
  const computedAt = input.now ?? new Date();
  const nowMs = computedAt.getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  try {
    const work = async (
      tx: import('@/lib/db').TenantTx,
    ): Promise<
      Result<RecomputeAtRiskScoresBatchOutput, RecomputeAtRiskScoresBatchError>
    > => {
      // 1. Read tenant settings + F6 availability inside the per-tenant
      //    lock (R4-W5 + PR #24 review-fix). Both reads must be
      //    co-located with the CTE so a tenant flipping settings or F6
      //    mid-cron cannot cause drift between read-time and
      //    CTE-compute-time.
      const settings = await deps.tenantRenewalSettingsRepo.findByTenant(
        input.tenantId,
      );
      const minTenureDays = settings?.minTenureDaysForAtRisk ?? 30;
      const f6Available = deps.eventAttendees.isAvailable();
      // 2. Single CTE: gather factor inputs for ALL active members in
      //    one round-trip via the port abstraction.
      const factorRows: ReadonlyArray<AtRiskBatchFactorRow> =
        await deps.memberRenewalFlagsRepo.gatherAtRiskFactorsForTenant(
          tx,
          input.tenantId,
        );

      // 3. Compute scores in-memory (no I/O). Per-member fault
      //    isolation: catch + count in membersFailed; never blocks the
      //    batch.
      const computed: ComputedRow[] = [];
      const skippedBelowTenure: Array<{
        readonly memberId: string;
        readonly tenureDays: number;
      }> = [];
      let membersFailed = 0;

      for (const row of factorRows) {
        try {
          const memberCreatedMs = new Date(row.memberCreatedAt).getTime();
          const tenureDays = Math.floor(
            (nowMs - memberCreatedMs) / MS_PER_DAY,
          );
          const daysSinceContactUpdate =
            row.lastActivityAtIso !== null
              ? Math.floor(
                  (nowMs - new Date(row.lastActivityAtIso).getTime()) /
                    MS_PER_DAY,
                )
              : undefined;
          const daysSinceLastPayment =
            row.lastPaidAtIso !== null
              ? Math.floor(
                  (nowMs - new Date(row.lastPaidAtIso).getTime()) /
                    MS_PER_DAY,
                )
              : undefined;

          const factors: AtRiskFactors = {
            tenureDays,
            ...(daysSinceContactUpdate !== undefined
              ? { daysSinceContactUpdate }
              : {}),
            invoicesOverdueCount: row.invoicesOverdueCount,
            ...(daysSinceLastPayment !== undefined
              ? { daysSinceLastPayment }
              : {}),
            // F7 e-blast quota — null ⇒ plan has no quota; Domain skips
            ...(row.eblastQuotaPctUsed !== null
              ? { eBlastQuotaPctUsed: row.eblastQuotaPctUsed }
              : {}),
            // F2 tier-downgrade — direct boolean
            tierDowngradedLast12Months: row.tierDowngradedLast12Months,
          };
          const r = computeAtRiskScorePure(factors, {
            minTenureDays,
            eventAttendeesAvailable: f6Available,
          });
          /* v8 ignore next 4 */
          if (!r.ok) {
            membersFailed += 1;
            continue;
          }
          if (r.value.skippedBelowMinTenure) {
            skippedBelowTenure.push({
              memberId: row.memberId,
              tenureDays,
            });
            continue;
          }
          computed.push({
            memberId: row.memberId,
            result: r.value,
            priorBand: row.priorRiskBand,
          });
        } catch (e) {
          membersFailed += 1;
          logger.warn(
            {
              err: e instanceof Error ? e.message : String(e),
              tenantId: input.tenantId,
              memberId: row.memberId,
              correlationId: input.correlationId,
            },
            'recompute-at-risk-batch.compute-member-threw',
          );
        }
      }

      // 4. Bulk UPDATE members.risk_score_* via the port.
      //
      // COMP-1 (companion to R3) — `bulkSetRiskScores` silently SKIPS a member
      // erased between candidate-listing (gatherAtRiskFactorsForTenant, which
      // already excludes erased members) and this write — the `erased_at IS
      // NULL` write-guard makes that row a no-op without re-leaking the scrubbed
      // quasi-identifiers. It RETURNS the member ids it actually wrote, so the
      // audit loop below can emit only for the real write set. Without this, a
      // member erased mid-batch would still get a spurious "recompute succeeded"
      // audit even though its row was never touched.
      const writtenMemberIds = new Set<string>();
      if (computed.length > 0) {
        const updateRows: ReadonlyArray<BulkSetRiskScoreRow> = computed.map(
          (c) => ({
            memberId: c.memberId,
            score: c.result.score,
            band: c.result.band,
            factors: Object.fromEntries(
              c.result.contributions.map((f) => [f.factor, f.points]),
            ),
          }),
        );
        const writeResult =
          await deps.memberRenewalFlagsRepo.bulkSetRiskScores(
            tx,
            input.tenantId,
            updateRows,
            computedAt,
          );
        for (const id of writeResult.writtenMemberIds) writtenMemberIds.add(id);
      }

      // 5. Bulk INSERT audit_log via the port. Build the events list
      //    in-memory (one recompute audit per member; one extra
      //    threshold_crossed per UP transition per FR-031; one
      //    skipped audit per min-tenure skip per FR-035).
      const events: F8AuditEvent<F8AuditEventType>[] = [];

      // Phase 6 review I10 — emit per-skipped-member audit
      // `at_risk_skipped_below_min_tenure` (FR-035 contract closure).
      // Previously the batched path only incremented a counter; the
      // single-member path emitted per member. The contract requires
      // per-member emit so dashboards and forensics can identify
      // which members were skipped, not just how many.
      for (const s of skippedBelowTenure) {
        events.push({
          type: 'at_risk_skipped_below_min_tenure',
          payload: {
            member_id: s.memberId as MemberId,
            tenure_days: s.tenureDays,
            threshold_days: minTenureDays,
          },
        });
      }

      for (const c of computed) {
        // COMP-1 (companion to R3) — gate the per-member audit on the ACTUAL
        // write. A member erased between candidate-listing and the bulk write
        // is write-skipped (erased_at IS NULL guard); emitting its
        // `at_risk_score_recomputed` (and the linked threshold_crossed) here
        // would record a "recompute succeeded" event for a row that was never
        // touched. In the normal (non-race) path every computed member is in
        // the write set, so this skip is inert.
        if (!writtenMemberIds.has(c.memberId)) continue;
        const factorsMap = Object.fromEntries(
          c.result.contributions.map((f) => [f.factor, f.points]),
        );
        events.push({
          type: 'at_risk_score_recomputed',
          payload: {
            member_id: c.memberId as MemberId,
            score: c.result.score,
            factors: factorsMap,
            threshold_band: c.result.band,
            active_max: c.result.activeMax,
            f6_active: !c.result.eventAttendanceFactorSkipped,
          },
        });
        if (
          c.priorBand !== null &&
          c.priorBand !== c.result.band &&
          BAND_ORDER[c.result.band] > BAND_ORDER[c.priorBand]
        ) {
          // BandTransition DU enforces previous_band !== new_band at
          // compile time + the 12 valid arms; build via a switch so TS
          // narrows each arm correctly.
          const memberId = c.memberId as MemberId;
          if (c.priorBand === 'healthy') {
            events.push({
              type: 'at_risk_score_threshold_crossed',
              payload: {
                member_id: memberId,
                previous_band: 'healthy',
                new_band: c.result.band as 'warning' | 'at-risk' | 'critical',
                score: c.result.score,
              },
            });
          } else if (c.priorBand === 'warning') {
            events.push({
              type: 'at_risk_score_threshold_crossed',
              payload: {
                member_id: memberId,
                previous_band: 'warning',
                new_band: c.result.band as 'at-risk' | 'critical',
                score: c.result.score,
              },
            });
          } else if (c.priorBand === 'at-risk') {
            events.push({
              type: 'at_risk_score_threshold_crossed',
              payload: {
                member_id: memberId,
                previous_band: 'at-risk',
                new_band: 'critical',
                score: c.result.score,
              },
            });
          }
          /* v8 ignore next */
          // 'critical' priorBand can never go UP — guard above is
          // already exclusive but kept for exhaustiveness.
        }
      }

      if (events.length > 0) {
        await deps.auditEmitter.bulkEmitInTx(tx, events, {
          tenantId: input.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        });
      }

      return ok({
        membersTotal: factorRows.length,
        // COMP-1 (companion to R3) — report the ACTUAL write set, not the
        // in-memory computed length. They diverge only in the rare TOCTOU
        // race where a member is erased between candidate-listing and the
        // bulk write (that member is write-skipped + audit-skipped + must not
        // be counted as recomputed). In the normal path the two are equal.
        membersRecomputed: writtenMemberIds.size,
        membersSkippedBelowTenure: skippedBelowTenure.length,
        membersFailed,
        durationMs: Date.now() - startedAt,
      });
    };
    if (externalTx !== undefined) {
      return await work(externalTx as import('@/lib/db').TenantTx);
    }
    return await runInTenant(deps.tenant, work);
  } catch (e) {
    const errInstance = e instanceof Error ? e : new Error(String(e));
    const message = errInstance.message;
    logger.error(
      {
        errMsg: message,
        errName: errInstance.name,
        errStack: errInstance.stack?.slice(0, 800),
        tenantId: input.tenantId,
        correlationId: input.correlationId,
      },
      'recompute-at-risk-batch.unexpected_error',
    );
    return err({ kind: 'server_error' as const, message });
  }
}
