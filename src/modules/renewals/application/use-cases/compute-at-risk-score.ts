/**
 * F8 Phase 6 Wave B · T154 — `computeAtRiskScore` use-case.
 *
 * Per-member at-risk score recompute. Driven by the weekly cron at
 * `/api/cron/renewals/at-risk-recompute/[tenantId]/route.ts` (Wave C
 * T161 — coordinator fans out to per-tenant; per-tenant route loops
 * over active members and calls this use-case once per member).
 *
 * Orchestrates:
 *   1. Call the AtRiskScorer port (Wave C T159 Drizzle adapter wires
 *      the CTE-based factor-gathering against F2+F3+F4+F6+F7) → returns
 *      `AtRiskScoreResult` already including F6-readiness fallback +
 *      min-tenure gate per FR-029a + FR-035.
 *   2. If the min-tenure gate skipped scoring → emit
 *      `at_risk_skipped_below_min_tenure` and return `ok({ skipped:
 *      true })` (no DB write — score+band stay at their previous
 *      values; tenure-eligible recomputes resume on the next pass).
 *   3. Else open `runInTenant` → setRiskScore (gets prior band) →
 *      emit `at_risk_score_recomputed` → if band crossed UP per FR-031
 *      emit `at_risk_score_threshold_crossed` (typed BandTransition DU
 *      enforces 12 valid 4×4-with-self-excluded transitions).
 *   4. Per-member fault isolation: any thrown error during scoring
 *      surfaces as `Result.err({ kind: 'server_error' })` so the cron
 *      loop can record + count the failure + continue with the next
 *      member; the cron emits one
 *      `at_risk_compute_partial_failure` audit per batch with
 *      aggregate counts.
 *
 * Cron-driven — `actorUserId` is null + `actorRole` is the constant
 * 'cron'. Manual recompute (admin-triggered debugging path) is
 * post-MVP and would extend this use-case with an `actorUserId` arg
 * + role='admin' literal.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import type { RiskBand } from '../../domain/value-objects/risk-band';
import { RISK_BAND_THRESHOLDS } from '../../domain/value-objects/risk-band';
// Type-only import — runtime no-op brand cast (Constitution Principle III)
import type { MemberId } from '@/modules/members';

export const computeAtRiskScoreInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type ComputeAtRiskScoreInput = z.infer<
  typeof computeAtRiskScoreInputSchema
>;

export type ComputeAtRiskScoreOutput =
  | {
      readonly skipped: true;
      readonly reason: 'below_min_tenure';
      readonly tenureDays: number;
      readonly thresholdDays: number;
    }
  | {
      readonly skipped: false;
      readonly score: number;
      readonly band: RiskBand;
      readonly previousBand: RiskBand | null;
      readonly bandCrossedUp: boolean;
      readonly f6Active: boolean;
    };

export type ComputeAtRiskScoreError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'member_not_found' }
  | { readonly kind: 'server_error'; readonly message: string };

/**
 * Numeric ordering of bands so we can detect "crossed UP". A band-down
 * crossing (e.g. critical → warning when factors improve) is informative
 * but not in scope for FR-031 (which is monthly-trend deterioration
 * reporting only). Down-crossings are silent.
 */
const BAND_ORDER: Readonly<Record<RiskBand, number>> = {
  healthy: 0,
  warning: 1,
  'at-risk': 2,
  critical: 3,
};

export async function computeAtRiskScore(
  deps: RenewalsDeps,
  rawInput: ComputeAtRiskScoreInput,
): Promise<Result<ComputeAtRiskScoreOutput, ComputeAtRiskScoreError>> {
  const inputResult = parseInput(computeAtRiskScoreInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  // Step 1 — score the member (factor-gathering + Domain compute is
  // delegated to the adapter; the use-case is purely orchestration).
  let scoreResult: Awaited<
    ReturnType<typeof deps.atRiskScorer.scoreMember>
  >;
  try {
    scoreResult = await deps.atRiskScorer.scoreMember(
      input.tenantId,
      input.memberId,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error(
      { err: message, tenantId: input.tenantId, memberId: input.memberId },
      '[compute-at-risk-score] scorer threw — propagating to cron for partial-failure audit',
    );
    return err({ kind: 'server_error' as const, message });
  }

  // Step 2 — min-tenure skip path (FR-035). Emit + return without
  // touching the score columns. Phase 6 review I4: emit real
  // `tenure_days` + `threshold_days` from the Domain result rather
  // than the prior 0/30 sentinels.
  if (scoreResult.skippedBelowMinTenure) {
    const tenureDays = scoreResult.tenureDays ?? 0;
    const thresholdDays = scoreResult.thresholdDays;
    try {
      await deps.auditEmitter.emit(
        {
          type: 'at_risk_skipped_below_min_tenure' as const,
          payload: {
            member_id: input.memberId as MemberId,
            tenure_days: tenureDays,
            threshold_days: thresholdDays,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      // Skip audit failure is non-blocking — log + continue. The next
      // cron pass will retry. Cron-loop fault isolation only roll-back
      // the per-member tx, never blocks the cron-pass.
      // R6-L1-err: include correlation context so SRE can find the
      // member + cron-pass in logs.
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: input.tenantId,
          memberId: input.memberId,
          correlationId: input.correlationId,
        },
        '[compute-at-risk-score] skip audit emit failed — non-blocking',
      );
      // R5-S1 fix: emit alertable counter so SRE can see silent
      // dropped audits (Constitution Principle VIII visibility — the
      // audit_log row never lands but the cron rolls forward).
      // Configure Vercel alert rule on
      // `renewals_at_risk_audit_emit_failed_total` per
      // docs/observability.md § 23.3 (sustained ≥1 in 5min → alarm).
      renewalsMetrics.atRiskAuditEmitFailed(
        'at_risk_skipped_below_min_tenure',
        input.tenantId,
      );
    }
    return ok({
      skipped: true as const,
      reason: 'below_min_tenure' as const,
      tenureDays,
      thresholdDays,
    });
  }

  // Step 3 — persist + emit recompute audits inside one tx.
  return runInTenant(deps.tenant, async (tx) => {
    // Convert Domain `contributions[]` (ordered list with weight values)
    // into the audit-payload `factors` map (key → points). The adapter
    // sets the corresponding JSONB column on members directly.
    const factorsMap = Object.fromEntries(
      scoreResult.contributions.map((c) => [c.factor, c.points]),
    ) as Parameters<
      typeof deps.memberRenewalFlagsRepo.setRiskScore
    >[3]['factors'];

    const persistResult = await deps.memberRenewalFlagsRepo.setRiskScore(
      tx,
      input.tenantId,
      input.memberId,
      {
        score: scoreResult.score,
        band: scoreResult.band,
        factors: factorsMap,
        // Use the injected ClockPort (renewals-deps § clock) so test fixtures
        // can pin computedAt — peer use-cases (cancel-cycle, supersede-pending-
        // tier-upgrade, …) already do; this site missed the Round-5 migration.
        computedAt: deps.clock.now().toISOString(),
      },
    );

    if (persistResult.affectedRows === 0) {
      return err({ kind: 'member_not_found' as const });
    }

    const previousBand = persistResult.previousBand;
    const newBand = scoreResult.band;
    const bandCrossedUp =
      previousBand !== null &&
      previousBand !== newBand &&
      BAND_ORDER[newBand] > BAND_ORDER[previousBand];

    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'at_risk_score_recomputed' as const,
          payload: {
            member_id: input.memberId as MemberId,
            score: scoreResult.score,
            factors: factorsMap,
            threshold_band: scoreResult.band,
            active_max: scoreResult.activeMax,
            f6_active: !scoreResult.eventAttendanceFactorSkipped,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
      // Phase 9 / T231 — business-volume counter (FR-029 score-recompute
      // dashboard). One increment per per-member score write. Tenant-
      // scoped so dashboards can compare cross-tenant volume.
      renewalsMetrics.atRiskScoresRecomputed(input.tenantId);

      // FR-031 — emit threshold-crossed only on UP transitions
      // (deterioration). Down-crossings are silent.
      if (bandCrossedUp && previousBand !== null) {
        await emitThresholdCrossed(
          deps,
          tx,
          input,
          previousBand,
          newBand,
          scoreResult.score,
        );
        // Phase 9 / T231 — band crossing counter (FR-031 / FR-029
        // up-transition signal). Both labels are bounded RiskBand
        // enum values; cardinality 4 × 4 = 16 max per tenant.
        renewalsMetrics.atRiskThresholdCrossing(
          input.tenantId,
          previousBand,
          newBand,
        );
      }
    } catch (e) {
      // Constitution Principle VIII reverse-direction atomicity —
      // audit failure inside tx rolls the score-write back.
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        '[compute-at-risk-score] audit emit failed inside tx — rolling back',
      );
      throw e;
    }

    return ok({
      skipped: false as const,
      score: scoreResult.score,
      band: scoreResult.band,
      previousBand,
      bandCrossedUp,
      f6Active: !scoreResult.eventAttendanceFactorSkipped,
    });
  });
}

/**
 * Emit `at_risk_score_threshold_crossed` per FR-031. The
 * `BandTransition` DU on the audit payload enforces previous_band !==
 * new_band at the type level so emitting "low → low" is a TS error;
 * we only call this when `bandCrossedUp === true` (verified at the
 * call site).
 *
 * The audit payload is a discriminated union over the 4×3=12 valid
 * arms. We construct it via a switch on `previousBand` so TypeScript
 * narrows each arm to the correct shape — a safer alternative to a
 * cast. RISK_BAND_THRESHOLDS is referenced only for the lint-compatible
 * import (otherwise TS prunes); the test does not need it.
 */
async function emitThresholdCrossed(
  deps: RenewalsDeps,
  tx: Parameters<typeof deps.auditEmitter.emitInTx>[0],
  input: ComputeAtRiskScoreInput,
  previousBand: RiskBand,
  newBand: RiskBand,
  score: number,
): Promise<void> {
  void RISK_BAND_THRESHOLDS;
  // Construct a typed BandTransition. The DU has 12 arms (4 previous ×
  // 3 self-excluded new). Build via a switch on previousBand so each
  // arm narrows to the correct DU member.
  const memberId = input.memberId as MemberId;
  const ctx = {
    tenantId: input.tenantId,
    actorUserId: null,
    actorRole: 'cron' as const,
    correlationId: input.correlationId,
    requestId: input.requestId ?? null,
  };
  switch (previousBand) {
    case 'healthy':
      // newBand is one of warning | at-risk | critical (BAND_ORDER guarantee)
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'at_risk_score_threshold_crossed',
          payload: {
            member_id: memberId,
            previous_band: 'healthy',
            new_band: newBand as 'warning' | 'at-risk' | 'critical',
            score,
          },
        },
        ctx,
      );
      return;
    case 'warning':
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'at_risk_score_threshold_crossed',
          payload: {
            member_id: memberId,
            previous_band: 'warning',
            new_band: newBand as 'at-risk' | 'critical',
            score,
          },
        },
        ctx,
      );
      return;
    case 'at-risk':
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'at_risk_score_threshold_crossed',
          payload: {
            member_id: memberId,
            previous_band: 'at-risk',
            new_band: 'critical',
            score,
          },
        },
        ctx,
      );
      return;
    case 'critical':
      // No upward transition possible from critical (BAND_ORDER === 3).
      // Defensive — the call-site bandCrossedUp guard never lets us
      // reach here. The /* v8 ignore next */ suppresses coverage for
      // unreachable branches.
      /* v8 ignore next */
      return;
  }
}
