/**
 * F8 Phase 5 Wave B · T121 — `loadRenewalSummary`.
 *
 * Read-side use-case feeding the public renewal page
 * (`/portal/renewal/[memberId]`). Returns the **frozen** plan price /
 * term / currency captured on the cycle row at creation time
 * (FR-021a) plus benefit-consumption summary (FR-021).
 *
 * Frozen-price guarantee: the cycle stores `frozen_plan_price_thb`,
 * `_term_months`, `_currency` so mid-cycle F2 plan price changes do
 * NOT shift the amount the member is asked to pay. T149 integration
 * test verifies the invariant end-to-end.
 *
 * Benefit-consumption summary: per FR-021 the page shows quota usage
 * (E-Blasts sent, cultural-tickets used). This now REUSES the F9
 * insights `computeBenefitUsage` use-case via the
 * `benefitConsumptionReader` port (the same source `/portal/benefits`
 * consumes) — F6 events + F7 broadcasts have shipped, so the original
 * MVP stub (always `benefitsAvailable=false`) is retired. The reader
 * returns `null` (→ neutral "unavailable" fallback) on member-not-found
 * / compute error / no metered entitlements; any null OR throw keeps
 * the page rendering (graceful degrade, never a 500).
 *
 * Cross-tenant: `cyclesRepo.findById` returns null on RLS-hidden rows.
 * Use-case emits `renewal_cross_tenant_probe` audit on null + returns
 * generic `summary_not_found` per Constitution Principle I clause 4.
 *
 * Cross-member: caller (route handler) MUST verify session.memberId
 * equals the URL `[memberId]` BEFORE invoking this use-case. The
 * use-case takes `memberId` as input + asserts it matches the cycle's
 * memberId — a token-verified entry from T120 already passes this
 * check transitively.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { asMemberId } from '@/modules/members';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  parseCycleId,
  type CycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';

export const loadRenewalSummaryInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  memberId: z.string().uuid(),
  /**
   * 'member' is the typical actor (signed in via session OR via the
   * T120 verified-token path). 'admin' is allowed so admins can preview
   * what the member sees.
   */
  actorRole: z.enum(['member', 'admin', 'manager']),
  /** Null for the public token-verified entry path. */
  actorUserId: z.string().nullable(),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type LoadRenewalSummaryInput = z.infer<
  typeof loadRenewalSummaryInputSchema
>;

export interface LoadRenewalSummaryOutput {
  readonly cycleId: string;
  readonly memberId: string;
  /** Cycle status — UI branches on `awaiting_payment` vs `lapsed` etc. */
  readonly status: RenewalCycle['status'];
  readonly planIdAtCycleStart: string;
  readonly tierAtCycleStart: RenewalCycle['tierAtCycleStart'];
  /**
   * Frozen at cycle creation per FR-021a. Decimal string (DB
   * `decimal(12,2)`) — UI formats with `Intl.NumberFormat` or thai-baht-text.
   */
  readonly frozenPlanPriceThb: string;
  readonly frozenPlanTermMonths: number;
  readonly frozenPlanCurrency: 'THB' | 'SEK' | 'EUR' | 'USD';
  /** ISO 8601 UTC. UI renders in member locale + BE display for th-TH. */
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly expiresAt: string;
  /**
   * Benefit-consumption summary. Empty array + benefitsAvailable=false
   * means "upstream module returned no data" (F6 not shipped yet, F7
   * quota repo not exposed, etc.). Production fallback copy: "Benefit
   * summary unavailable" rather than misleading 0/N counts.
   */
  readonly benefits: ReadonlyArray<BenefitConsumptionEntry>;
  readonly benefitsAvailable: boolean;
  /**
   * First-time-renewer flag — true if the member has no prior
   * `completed` cycles. Drives the onboarding banner per US3 AS1.
   * Computed by counting prior closed cycles in the same tenant.
   */
  readonly isFirstTimeRenewer: boolean;
}

export interface BenefitConsumptionEntry {
  readonly key: 'eblast' | 'cultural_ticket' | 'event_attendance';
  readonly used: number;
  readonly quota: number | null;
  // NOTE: no `label` — the human-readable benefit name is resolved in
  // Presentation via i18n (`portal.renewal.benefits.name.<key>`). The
  // Application layer must not resolve i18n strings (Constitution
  // Principle III); the page already resolves tier/plan keys → labels
  // the same way.
}

export type LoadRenewalSummaryError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'summary_not_found' }
  | {
      readonly kind: 'cross_member_probe';
      readonly attemptedMemberId: string;
    };

export async function loadRenewalSummary(
  deps: RenewalsDeps,
  rawInput: LoadRenewalSummaryInput,
): Promise<Result<LoadRenewalSummaryOutput, LoadRenewalSummaryError>> {
  const parsed = loadRenewalSummaryInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const cycleIdParsed = parseCycleId(input.cycleId);
  if (!cycleIdParsed.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const cycleId: CycleId = cycleIdParsed.value;

  const cycle = await deps.cyclesRepo.findById(input.tenantId, cycleId);
  if (!cycle) {
    // RLS-hidden OR truly missing — emit defensive cross-tenant probe
    // audit per Constitution Principle I clause 4 (consistent with
    // load-cycle-detail.ts precedent). Try/catch so probe emit never
    // masks the 404 response.
    try {
      await deps.auditEmitter.emit(
        {
          type: 'renewal_cross_tenant_probe' as const,
          payload: {
            attempted_cycle_id: cycleId,
            route: 'load-renewal-summary',
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        '[load-renewal-summary] cross-tenant audit emit failed',
      );
    }
    return err({ kind: 'summary_not_found' });
  }

  // Cross-member guard — cycle exists in tenant but for a different
  // member. Emit `renewal_cross_member_probe` audit + return same
  // user-visible 404 (no oracle).
  if (cycle.memberId !== input.memberId) {
    try {
      await deps.auditEmitter.emit(
        {
          type: 'renewal_cross_member_probe' as const,
          payload: {
            // I13 review-fix: branded asMemberId() not `as never`.
            actor_member_id: asMemberId(input.memberId),
            attempted_member_id: asMemberId(cycle.memberId),
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.warn(
        { err: e instanceof Error ? e.message : String(e) },
        '[load-renewal-summary] cross-member audit emit failed',
      );
    }
    return err({
      kind: 'cross_member_probe',
      attemptedMemberId: cycle.memberId,
    });
  }

  // Build summary from cycle row alone — frozen price + term + currency
  // already de-normalised onto the cycle (data-model.md § 2.1). Plan
  // name lookup is the route handler's job (it has F2 plans-repo
  // access; T121 stays free of cross-module reads at this layer).
  // PR #24 review-fix — first-time-renewer detection wired via the
  // existing `cyclesRepo.list` port (no new sibling port needed). A
  // member is "first-time renewing" when they have ZERO **prior**
  // completed renewal cycles. We probe with `pageSize: 1` since we only
  // care about existence; the query is bounded by `(tenant_id,
  // member_id, status)` index and runs in <2ms on the F8 schema.
  //
  // `excludeCycleId: cycle.cycleId` is REQUIRED — without it, a member
  // viewing the summary of their own already-completed cycle (e.g. a
  // historical/post-renew read) would self-count and `isFirstTimeRenewer`
  // would falsely resolve to `false` for a true first-timer the moment
  // their cycle reaches `completed`. The filter scopes the probe to
  // *other* completed cycles only (`cycle_id <> current`).
  //
  // UX-review R5/C3 prior default-to-`false` rationale still applies as
  // a fail-safe: if the probe throws or the port surface drifts, we
  // continue to render with `isFirstTimeRenewer: false` (silent banner)
  // rather than emitting a wrong-copy banner to a 5-year veteran.
  let isFirstTimeRenewer = false;
  try {
    const completedPage = await deps.cyclesRepo.list(input.tenantId, {
      pageSize: 1,
      memberIdFilter: cycle.memberId,
      statusFilter: ['completed'],
      excludeCycleId: cycle.cycleId,
    });
    isFirstTimeRenewer = completedPage.items.length === 0;
  } catch (e) {
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: input.tenantId,
        cycleId: cycle.cycleId,
        memberId: cycle.memberId,
      },
      '[load-renewal-summary] first-time-renewer probe failed; defaulting to false',
    );
  }

  // Benefit-consumption summary (FR-021). Reuses the F9 insights
  // `computeBenefitUsage` use-case via the `benefitConsumptionReader`
  // port (the same source `/portal/benefits` consumes). The reader
  // returns `null` when the data is unavailable (member-not-found /
  // compute error / no metered entitlements) → we keep the neutral
  // `[] / benefitsAvailable=false` fallback so the page shows "Benefit
  // summary unavailable" rather than misleading 0/N counts.
  //
  // GRACEFUL FALLBACK (REQUIRED): any null OR throw keeps `[] / false`.
  // A benefit-read failure must NEVER turn the renewal page into a 500.
  // Mirrors the `isFirstTimeRenewer` try/catch fail-safe above.
  let benefits: ReadonlyArray<BenefitConsumptionEntry> = [];
  let benefitsAvailable = false;
  try {
    const consumption = await deps.benefitConsumptionReader.read(
      input.tenantId,
      cycle.memberId,
    );
    if (consumption !== null) {
      benefits = consumption;
      benefitsAvailable = true;
    }
  } catch (e) {
    logger.warn(
      {
        errKind: errKind(e),
        tenantId: input.tenantId,
        cycleId: cycle.cycleId,
        memberId: cycle.memberId,
      },
      '[load-renewal-summary] benefit-consumption read failed; rendering unavailable',
    );
  }

  return ok({
    cycleId: cycle.cycleId,
    memberId: cycle.memberId,
    status: cycle.status,
    planIdAtCycleStart: cycle.planIdAtCycleStart,
    tierAtCycleStart: cycle.tierAtCycleStart,
    frozenPlanPriceThb: cycle.frozenPlanPriceThb,
    frozenPlanTermMonths: cycle.frozenPlanTermMonths,
    frozenPlanCurrency: cycle.frozenPlanCurrency,
    periodFrom: cycle.periodFrom,
    periodTo: cycle.periodTo,
    expiresAt: cycle.expiresAt,
    benefits,
    benefitsAvailable,
    isFirstTimeRenewer,
  });
}
