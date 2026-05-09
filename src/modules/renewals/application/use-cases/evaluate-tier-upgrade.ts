/**
 * F8 Phase 7 T179 — `evaluateTierUpgrade` use-case.
 *
 * Weekly cron-entry point per FR-037 + FR-038. Iterates "active
 * members" (FR-007a canonical: `members.status='active'` AND
 * `renewal_cycles.status NOT IN ('lapsed','cancelled')`), checks each
 * against the next-higher tier's eligibility threshold per the F2
 * plan catalogue, and inserts a `TierUpgradeSuggestion` row when:
 *
 *   1. member objectively qualifies (turnover OR 12m paid invoice
 *      volume crosses the threshold);
 *   2. member's current `plan_id` is NOT already at-or-above the
 *      target tier;
 *   3. no active suggestion exists (member_open partial unique
 *      enforces at most one open OR pending-apply per member);
 *   4. no `dismissed` suggestion is suppressing the recommendation
 *      (90-day suppression per FR-039 / AS3).
 *
 * Audit emit per branch:
 *   - `tier_upgrade_suggested`                       — happy path insert
 *   - `tier_upgrade_already_at_target`               — debug: member already upgraded (FR-AS4)
 *   - `tier_upgrade_tenant_disabled`                 — once per cron pass when feature off (FR-AS6)
 *   - `tier_upgrade_skipped_no_thresholds_configured`— once per cron pass when catalogue empty (FR-AS5)
 *
 * Idempotent: re-running on the same data does NOT insert duplicates
 * (the member_open partial UNIQUE in migration 0091 raises a
 * `TierUpgradeOpenConflictError` which the use-case catches and
 * treats as a silent no-op).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import {
  TierUpgradeOpenConflictError,
  type NewTierUpgradeSuggestionInput,
} from '../ports/tier-upgrade-suggestion-repo';
import type { TierUpgradeEvalCandidate } from '../ports/tier-upgrade-eval-candidate-repo';
import type { PlanCatalogEntry } from '../ports/plan-catalog-port';
import type {
  TierUpgradeReasonCode,
  TierUpgradeEvidence,
} from '../../domain/tier-upgrade-suggestion';
// Type-only — runtime no-op brand cast (Constitution Principle III).
import type { MemberId, PlanId } from '@/modules/members';

export const evaluateTierUpgradeInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  pageSize: z.number().int().min(1).max(1000),
});

export type EvaluateTierUpgradeInput = z.infer<
  typeof evaluateTierUpgradeInputSchema
>;

export const DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE = 500;

export interface EvaluateTierUpgradeOutput {
  readonly tenantSkipped:
    | { readonly reason: 'tenant_disabled' }
    | { readonly reason: 'no_thresholds_configured' }
    | null;
  readonly membersScanned: number;
  readonly suggestionsCreated: number;
  readonly alreadyAtTarget: number;
  readonly suppressedSkipped: number;
  readonly conflictSkipped: number;
  readonly durationMs: number;
}

export type EvaluateTierUpgradeError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

/**
 * Decide whether `candidate` qualifies for an upgrade per the
 * sorted plan catalogue. Returns the chosen target plan + reason +
 * evidence, or null when no upgrade is warranted.
 *
 * Catalogue is pre-sorted ascending by `minTurnoverThb NULLS FIRST`
 * (per `PlanCatalogPort.listForTenant` contract). The decision walks
 * the catalogue and picks the HIGHEST plan whose threshold is
 * crossed AND whose tier-bucket is strictly above the member's
 * current bucket (so a same-bucket plan with no threshold doesn't
 * trigger a no-op upgrade). Multi-signal reason fires when BOTH
 * turnover AND 12m paid-invoice volume cross.
 */
function decideUpgrade(
  candidate: TierUpgradeEvalCandidate,
  catalogue: ReadonlyArray<PlanCatalogEntry>,
): {
  readonly toPlan: PlanCatalogEntry;
  readonly reasonCode: TierUpgradeReasonCode;
  readonly evidence: TierUpgradeEvidence;
} | null {
  const currentPlan = catalogue.find(
    (p) => p.planId === candidate.currentPlanId,
  );
  if (!currentPlan) return null; // member's plan not in catalogue (deleted)

  // Iterate catalogue in descending priority (highest threshold first)
  // so the cron picks the most aspirational tier the member qualifies
  // for in a single pass.
  const candidatesAbove = catalogue
    .filter(
      (p) =>
        p.isActive &&
        p.minTurnoverThb !== null &&
        // Strictly higher than the member's current threshold (or any
        // bucket above when current bucket has no threshold).
        (currentPlan.minTurnoverThb === null ||
          p.minTurnoverThb > currentPlan.minTurnoverThb),
    )
    .sort((a, b) => (b.minTurnoverThb ?? 0) - (a.minTurnoverThb ?? 0));

  for (const target of candidatesAbove) {
    const turnoverCrosses =
      candidate.turnoverThb !== null &&
      candidate.turnoverThb >= (target.minTurnoverThb ?? Infinity);
    // 12m paid-invoice volume threshold = N × current annual fee. Per
    // research.md, "12-month invoice spend with the chamber crossed
    // N×their plan's annual fee" — N=2 is the conservative default.
    const invoiceVolumeThreshold = currentPlan.annualFeeThb * 2;
    const invoiceVolumeCrosses =
      currentPlan.annualFeeThb > 0 &&
      candidate.paidInvoiceVolume12mThb >= invoiceVolumeThreshold;

    if (!turnoverCrosses && !invoiceVolumeCrosses) continue;

    const thresholdMetAt = new Date().toISOString();
    if (turnoverCrosses && invoiceVolumeCrosses) {
      return {
        toPlan: target,
        reasonCode: 'multi_signal',
        evidence: {
          reasonCode: 'multi_signal',
          turnoverThb: candidate.turnoverThb!,
          invoiceVolumeThb: candidate.paidInvoiceVolume12mThb,
          thresholdMetAt,
        },
      };
    }
    if (turnoverCrosses) {
      return {
        toPlan: target,
        reasonCode: 'declared_turnover_above_threshold',
        evidence: {
          reasonCode: 'declared_turnover_above_threshold',
          turnoverThb: candidate.turnoverThb!,
          thresholdMetAt,
        },
      };
    }
    return {
      toPlan: target,
      reasonCode: 'paid_invoice_volume_above_threshold',
      evidence: {
        reasonCode: 'paid_invoice_volume_above_threshold',
        invoiceVolumeThb: candidate.paidInvoiceVolume12mThb,
        thresholdMetAt,
      },
    };
  }
  return null;
}

export async function evaluateTierUpgrade(
  deps: RenewalsDeps,
  rawInput: EvaluateTierUpgradeInput,
): Promise<Result<EvaluateTierUpgradeOutput, EvaluateTierUpgradeError>> {
  const inputResult = parseInput(evaluateTierUpgradeInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const startedAt = Date.now();
  const correlationId = input.correlationId;
  const tenantId = input.tenantId;

  // ----- Tenant-disabled gate (FR-AS6) ------------------------------------
  const settings = await deps.tenantRenewalSettingsRepo.findByTenant(tenantId);
  if (settings && !settings.autoUpgradeEnabled) {
    try {
      await deps.auditEmitter.emit(
        { type: 'tier_upgrade_tenant_disabled', payload: {} },
        {
          tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), tenantId },
        '[evaluate-tier-upgrade] tenant_disabled audit emit failed',
      );
    }
    return ok({
      tenantSkipped: { reason: 'tenant_disabled' as const },
      membersScanned: 0,
      suggestionsCreated: 0,
      alreadyAtTarget: 0,
      suppressedSkipped: 0,
      conflictSkipped: 0,
      durationMs: Date.now() - startedAt,
    });
  }

  // ----- Plan catalogue (FR-AS5) ------------------------------------------
  let catalogue: ReadonlyArray<PlanCatalogEntry> = [];
  try {
    catalogue = await deps.planCatalog.listForTenant(tenantId);
  } catch (e) {
    return err({
      kind: 'server_error',
      message: `plan_catalog_read_failed: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }
  const hasAnyThreshold = catalogue.some((p) => p.minTurnoverThb !== null);
  if (!hasAnyThreshold) {
    try {
      await deps.auditEmitter.emit(
        { type: 'tier_upgrade_skipped_no_thresholds_configured', payload: {} },
        {
          tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e), tenantId },
        '[evaluate-tier-upgrade] no_thresholds audit emit failed',
      );
    }
    return ok({
      tenantSkipped: { reason: 'no_thresholds_configured' as const },
      membersScanned: 0,
      suggestionsCreated: 0,
      alreadyAtTarget: 0,
      suppressedSkipped: 0,
      conflictSkipped: 0,
      durationMs: Date.now() - startedAt,
    });
  }

  // ----- Per-member evaluation loop --------------------------------------
  let cursor: string | undefined;
  let membersScanned = 0;
  let suggestionsCreated = 0;
  let alreadyAtTarget = 0;
  let suppressedSkipped = 0;
  let conflictSkipped = 0;

  do {
    const page = await deps.tierUpgradeEvalCandidateRepo.list(tenantId, {
      pageSize: input.pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    for (const candidate of page.items) {
      membersScanned++;
      const decision = decideUpgrade(candidate, catalogue);
      if (decision === null) {
        alreadyAtTarget++;
        continue;
      }

      // Suppression check (FR-AS3 — 90-day suppress after Dismiss).
      const isSuppressed = await deps.tierUpgradeRepo.isSuppressedForMember(
        tenantId,
        candidate.memberId,
        new Date().toISOString(),
      );
      if (isSuppressed) {
        suppressedSkipped++;
        continue;
      }

      // Insert suggestion + audit emit (atomic per Principle VIII).
      try {
        await runInTenant(deps.tenant, async (tx) => {
          const newSuggestion: NewTierUpgradeSuggestionInput = {
            tenantId,
            suggestionId: deps.suggestionIdGenerator(),
            memberId: candidate.memberId,
            fromPlanId: candidate.currentPlanId,
            toPlanId: decision.toPlan.planId,
            reasonCode: decision.reasonCode,
            evidence: decision.evidence,
          };
          const inserted = await deps.tierUpgradeRepo.insertOpen(
            tx,
            newSuggestion,
          );
          await deps.auditEmitter.emitInTx(
            tx,
            {
              type: 'tier_upgrade_suggested',
              payload: {
                suggestion_id: inserted.suggestionId,
                member_id: candidate.memberId as MemberId,
                from_plan_id: candidate.currentPlanId as PlanId,
                to_plan_id: decision.toPlan.planId as PlanId,
                reason_code: decision.reasonCode,
              },
            },
            {
              tenantId,
              actorUserId: null,
              actorRole: 'cron',
              correlationId,
              requestId: input.requestId ?? null,
            },
          );
        });
        suggestionsCreated++;
      } catch (e) {
        if (e instanceof TierUpgradeOpenConflictError) {
          // Idempotent — another cron pass beat us OR a member-open
          // suggestion already exists. Silent no-op per FR-AS1.
          conflictSkipped++;
          continue;
        }
        return err({
          kind: 'server_error',
          message: `insert_open_failed: ${(e as Error)?.message ?? 'unknown'}`,
        });
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return ok({
    tenantSkipped: null,
    membersScanned,
    suggestionsCreated,
    alreadyAtTarget,
    suppressedSkipped,
    conflictSkipped,
    durationMs: Date.now() - startedAt,
  });
}
