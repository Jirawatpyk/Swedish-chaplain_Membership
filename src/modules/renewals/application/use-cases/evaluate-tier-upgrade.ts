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
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import type { NewTierUpgradeSuggestionInput } from '../ports/tier-upgrade-suggestion-repo';
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

/**
 * Round 6 W-001 — optional `outerTx` parameter so callers that hold a
 * per-tenant advisory lock (the per-tenant cron route) can thread their
 * lock-holding tx through to the suggestion-insert + audit-emit writes.
 *
 * Without this thread, the route would open `runInTenant` for the lock,
 * then `evaluateTierUpgrade` would open a SECOND `runInTenant` per
 * suggestion via the global `db.transaction(...)` — which checks out a
 * NEW pool connection. The lock holds on connection A; writes happen on
 * connection B. Serialisation across cron passes still works (a second
 * coordinator's lock-acquire blocks on connection A's tx) BUT the inner
 * writes do not benefit from the lock-holding session's `SET LOCAL`
 * scope and are diagnostically harder to trace as one logical work unit.
 *
 * Trade-off when `outerTx` is passed: a single audit-emit failure aborts
 * the whole pass. Accepted because the partial-UNIQUE `member_open_uniq`
 * catches the most common conflict path BEFORE tx abort, and other
 * failures are rare-and-loud (server_error → cron retries next week).
 *
 * **IMPORTANT scope limit (Round 6 Round-7 CRITICAL-2)**: only the
 * suggestion-insert + audit-emit WRITE paths participate in `outerTx`.
 * The early-stage READS — `tenantRenewalSettingsRepo.findByTenant` and
 * `planCatalog.listForTenant` and `tierUpgradeRepo.isSuppressedForMember`
 * — still run on their own connections (their port signatures don't
 * accept a `tx` param yet). Implication: in the rare TOCTOU window
 * between lock-acquire and the loop body, an admin who flips
 * `auto_upgrade_enabled = false` could see suggestions still inserted
 * for that pass (the settings read happened pre-flip). The suggestion-
 * insert idempotency + the next cron pass's tenant_disabled gate
 * absorb the residual risk; documenting the gap so future work
 * (extending the read repos to accept `tx`) has a known target.
 */
export async function evaluateTierUpgrade(
  deps: RenewalsDeps,
  rawInput: EvaluateTierUpgradeInput,
  outerTx?: TenantTx,
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
        {
          type: 'tier_upgrade_skipped_no_thresholds_configured',
          payload: {
            catalogue_size: catalogue.length,
            // Phase 7 review-fix Round 2 IMP-2: explicit discriminator
            // so dashboards distinguish onboarding-gap (0 plans) from
            // config-gap (N plans, no thresholds set).
            skip_reason: catalogue.length === 0 ? 'no_plans' : 'no_thresholds_set',
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

  // F8 Phase 10 T262 batched-write — collapse the per-member RTT
  // amplification into 3 RTTs per page (bulk-suppression-check +
  // bulk-insert + bulk-emit) regardless of page size. Pre-batched
  // implementation issued 3 RTTs per above-threshold member on the
  // outerTx-threaded path (suppression check + insert + audit emit) →
  // T264 perf bench captured 98s @ 1k members. Post-batched: 2.21s
  // @ 1k local (44× speedup); 11.4s @ 5k strict mode PASS.
  // T262 dispatch path — bulk port methods landed at commit `2caa8d74`
  // (`RenewalReminderEventRepo.bulkInsertIfAbsent` + `bulkTransitionToSent`).
  // Per R5 verify-fix re-analysis (perf-benchmarks.md § T262 + retrospective
  // § S1): the dispatch outer-loop is INTENTIONALLY NOT WIRED because
  // production SLO is met today via Resend gateway-IO dominance +
  // DISPATCH_CONCURRENCY=10 amortization. The bulk infrastructure is
  // shipped + tested for future use if Resend latency drops. NOT a
  // deferral — explicit non-usage decision.
  type PageDecision = {
    readonly candidate: import('../ports/tier-upgrade-eval-candidate-repo').TierUpgradeEvalCandidate;
    readonly decision: NonNullable<ReturnType<typeof decideUpgrade>>;
  };
  // R5-B1 fix: flushPage no longer carries a serverError discriminator.
  // Bulk-insert + bulk-emit failures THROW (not return Result.err) so
  // `runInTenant` rolls back atomically per Constitution Principle VIII
  // state↔audit atomicity. The outer loop catches at the use-case
  // boundary and converts to err({kind:'server_error'}) for the route.
  const flushPage = async (
    tx: TenantTx,
    pageDecisions: ReadonlyArray<PageDecision>,
    nowIso: string,
  ): Promise<{
    readonly suppressedSkipped: number;
    readonly suggestionsCreated: number;
    readonly conflictSkipped: number;
  }> => {
    if (pageDecisions.length === 0) {
      return {
        suppressedSkipped: 0,
        suggestionsCreated: 0,
        conflictSkipped: 0,
      };
    }
    const memberIds = pageDecisions.map((pd) => pd.candidate.memberId);

    // 1 RTT — bulk suppression check.
    const suppressedSet = await deps.tierUpgradeRepo.bulkGetSuppressedMembers(
      tx,
      memberIds,
      nowIso,
    );
    const unsuppressed = pageDecisions.filter(
      (pd) => !suppressedSet.has(pd.candidate.memberId),
    );
    const suppressedCount = pageDecisions.length - unsuppressed.length;
    if (unsuppressed.length === 0) {
      return {
        suppressedSkipped: suppressedCount,
        suggestionsCreated: 0,
        conflictSkipped: 0,
      };
    }

    // 1 RTT — bulk insert ON CONFLICT DO NOTHING.
    const insertInputs: ReadonlyArray<NewTierUpgradeSuggestionInput> =
      unsuppressed.map((pd) => ({
        tenantId,
        suggestionId: deps.suggestionIdGenerator(),
        memberId: pd.candidate.memberId,
        fromPlanId: pd.candidate.currentPlanId,
        toPlanId: pd.decision.toPlan.planId,
        reasonCode: pd.decision.reasonCode,
        evidence: pd.decision.evidence,
      }));
    let bulkResult: Awaited<
      ReturnType<typeof deps.tierUpgradeRepo.bulkInsertOpenIfAbsent>
    >;
    try {
      bulkResult = await deps.tierUpgradeRepo.bulkInsertOpenIfAbsent(
        tx,
        insertInputs,
      );
    } catch (e) {
      // R5-B1 fix (Constitution Principle VIII state↔audit atomicity):
      // RE-THROW so `runInTenant` rolls back the surrounding tx. The
      // previous `return err({serverError})` semantics let `runInTenant`
      // commit a partial state (advisory lock acquired, no rows
      // written here but the prior page's writes already committed),
      // which combined with `member_open_uniq` partial UNIQUE blocked
      // future replay. Re-throw preserves the all-or-nothing contract:
      // either the whole page commits (insert + audit) or nothing does.
      throw new Error(
        `bulk_insert_open_failed: ${(e as Error)?.message ?? 'unknown'}`,
        { cause: e },
      );
    }

    // 1 RTT — bulk audit emit (T159b precedent on RenewalAuditEmitter).
    if (bulkResult.inserted.length > 0) {
      const insertedByMember = new Map(
        bulkResult.inserted.map((s) => [s.memberId, s]),
      );
      const auditEvents = unsuppressed
        .map((pd) => {
          const inserted = insertedByMember.get(pd.candidate.memberId);
          if (!inserted) return null;
          return {
            type: 'tier_upgrade_suggested' as const,
            payload: {
              suggestion_id: inserted.suggestionId,
              member_id: pd.candidate.memberId as MemberId,
              from_plan_id: pd.candidate.currentPlanId as PlanId,
              to_plan_id: pd.decision.toPlan.planId as PlanId,
              reason_code: pd.decision.reasonCode,
            },
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);
      try {
        await deps.auditEmitter.bulkEmitInTx(tx, auditEvents, {
          tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId: input.requestId ?? null,
        });
      } catch (e) {
        // R5-B1 fix (Constitution Principle VIII state↔audit atomicity):
        // RE-THROW so `runInTenant` rolls back the bulk INSERT we just
        // landed above. Returning serverError here would leave
        // `tier_upgrade_suggestions` rows persisted with NO matching
        // audit row — a textbook state↔audit drift that future replay
        // cannot recover (member_open_uniq blocks re-insert).
        throw new Error(
          `bulk_emit_failed: ${(e as Error)?.message ?? 'unknown'}`,
          { cause: e },
        );
      }
      // Phase 9 / T231 metrics — emit 1 counter per inserted suggestion
      // (in-memory only; no RTT cost). Preserves the per-tier-bucket
      // dashboard granularity from the pre-batched path.
      for (const pd of unsuppressed) {
        if (insertedByMember.has(pd.candidate.memberId)) {
          renewalsMetrics.tierUpgradeSuggestionsCreated(
            tenantId,
            pd.decision.toPlan.renewalTierBucket,
          );
        }
      }
    }
    return {
      suppressedSkipped: suppressedCount,
      suggestionsCreated: bulkResult.inserted.length,
      conflictSkipped: bulkResult.conflicted.length,
    };
  };

  do {
    const page = await deps.tierUpgradeEvalCandidateRepo.list(tenantId, {
      pageSize: input.pageSize,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const pageDecisions: PageDecision[] = [];
    for (const candidate of page.items) {
      membersScanned++;
      const decision = decideUpgrade(candidate, catalogue);
      if (decision === null) {
        alreadyAtTarget++;
        // Round 6 W-010 — REMOVED per-member `tier_upgrade_already_at_target`
        // audit emit. Aggregate audit emits once after the loop below.
        continue;
      }
      pageDecisions.push({ candidate, decision });
    }

    if (pageDecisions.length > 0) {
      const nowIso = new Date().toISOString();
      // Use outerTx when supplied (cron route holds advisory lock).
      // Otherwise open a single runInTenant for the WHOLE page (3 RTTs
      // total) instead of per-member (3 RTTs × N members).
      // R5-B1 fix: bulk-insert + bulk-emit failures throw (not Result.err)
      // so runInTenant rolls back atomically per Constitution VIII.
      // R6-B1 fix: when `outerTx` is provided (production cron path),
      // the throw MUST propagate up to the route's `runInTenant`
      // closure so its tx rolls back. Catching here would let the
      // outer tx COMMIT (because the closure returned normally with a
      // Result.err value, which is NOT how runInTenant signals
      // rollback) → state↔audit drift returns. The standalone
      // (non-outerTx) path still converts to Result.err because the
      // page-scoped runInTenant already rolled back atomically and
      // the use-case caller expects a Result return.
      if (outerTx) {
        // Production cron path: do NOT swallow — let route's
        // runInTenant rollback. flushPage failure is a real defect
        // that pages on-call (F8-A1 + F8-A2 alerts).
        const flushResult = await flushPage(outerTx, pageDecisions, nowIso);
        suppressedSkipped += flushResult.suppressedSkipped;
        suggestionsCreated += flushResult.suggestionsCreated;
        conflictSkipped += flushResult.conflictSkipped;
      } else {
        // Standalone path (admin replay, integration test): open the
        // page-scoped runInTenant so it rolls back on throw, then
        // catch at the use-case boundary + convert to err({server_error}).
        try {
          const flushResult = await runInTenant(deps.tenant, (tx) =>
            flushPage(tx, pageDecisions, nowIso),
          );
          suppressedSkipped += flushResult.suppressedSkipped;
          suggestionsCreated += flushResult.suggestionsCreated;
          conflictSkipped += flushResult.conflictSkipped;
        } catch (e) {
          // R6-LOW2 close: prefer instanceof Error narrowing over
          // `(e as Error)?.message` — handles non-Error throws safely.
          const message =
            e instanceof Error ? e.message : String(e ?? 'flush_page_failed');
          return err({
            kind: 'server_error',
            message,
          });
        }
      }
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  // Round 6 W-010 — single aggregate `tier_upgrade_already_at_target`
  // audit per cron pass (replaces the per-member emit removed above).
  // Mirrors the existing per-cron-run pattern of `tier_upgrade_tenant_disabled`
  // (FR-AS6) and `tier_upgrade_skipped_no_thresholds_configured` (FR-AS5).
  // Skip emit when `alreadyAtTarget === 0` to keep dashboards quiet.
  if (alreadyAtTarget > 0) {
    try {
      await deps.auditEmitter.emit(
        {
          type: 'tier_upgrade_already_at_target',
          // Per-cron summary fields (Round 6 W-010 aggregate shape).
          // The audit-event-payload union has two variants:
          //   - aggregate: { already_at_target_count, members_scanned }
          //   - per-member (historical): { member_id, current_plan_id }
          // We always emit the aggregate variant from this code path; the
          // explicit literal lands on the aggregate arm of the union (no
          // `Record<string, unknown>` widening needed).
          payload: {
            already_at_target_count: alreadyAtTarget,
            members_scanned: membersScanned,
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
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId,
          correlationId,
          alreadyAtTarget,
        },
        '[evaluate-tier-upgrade] aggregate already_at_target audit emit failed — counter only',
      );
      // Staff-R004 fix: emit alertable counter so SRE can detect
      // silent dropped audits (drift vs the R5-S1 atRiskAuditEmitFailed
      // pattern). Without this counter, every aggregate audit-emit
      // failure leaves only a logger.warn breadcrumb. Vercel alert
      // rule per docs/observability.md F8-A11 (sustained ≥1 in 5 min
      // → alarm). Per-tenant tag enables tenant-scoped dashboards.
      renewalsMetrics.tierUpgradeAuditEmitFailed(
        'tier_upgrade_already_at_target',
        tenantId,
      );
    }
  }

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
