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

  // 1. Read tenant settings ONCE (1 round-trip).
  const settings = await deps.tenantRenewalSettingsRepo.findByTenant(
    input.tenantId,
  );
  const minTenureDays = settings?.minTenureDaysForAtRisk ?? 30;
  const f6Available = deps.eventAttendees.isAvailable();
  const computedAt = new Date();
  const nowMs = computedAt.getTime();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  try {
    return await runInTenant(deps.tenant, async (tx) => {
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
      let membersFailed = 0;
      let membersSkippedBelowTenure = 0;

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
            membersSkippedBelowTenure += 1;
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
        await deps.memberRenewalFlagsRepo.bulkSetRiskScores(
          tx,
          input.tenantId,
          updateRows,
          computedAt,
        );
      }

      // 5. Bulk INSERT audit_log via the port. Build the events list
      //    in-memory (one recompute audit per member; one extra
      //    threshold_crossed per UP transition per FR-031).
      const events: F8AuditEvent<F8AuditEventType>[] = [];
      for (const c of computed) {
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
        membersRecomputed: computed.length,
        membersSkippedBelowTenure,
        membersFailed,
        durationMs: Date.now() - startedAt,
      });
    });
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
