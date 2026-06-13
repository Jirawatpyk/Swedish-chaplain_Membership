/**
 * F8-completion Slice 1 · Task 1.2 — `createCycleInTx` shared helper.
 *
 * The SINGLE home for all cycle-creation invariants. Every cycle-
 * creation entry point consumes it — none forks a parallel creator:
 *   - the on-paid steady-state callback (`create-next-cycle-on-paid`),
 *   - the member import cold-start,
 *   - the create-member onboarding listener,
 *   - the Slice-3 admin lapsed-comeback fresh cycle.
 *
 * Responsibilities (in order):
 *   1. In-tx-visible idempotency no-op via `findActiveForMemberInTx`
 *      (NEVER the connection-fresh `findActiveForMember` — that cannot
 *      see an uncommitted prior-cycle `→completed` flip made earlier in
 *      the SAME tx, which would make the on-paid creation no-op on first
 *      delivery; see Task 1.1).
 *   2. Frozen-price snapshot via `loadPlanFrozenFields` (FR-021a — the
 *      cycle freezes the resolved plan's price/term/tier at creation
 *      time; never overwritten afterwards).
 *   3. Gapless period derivation: `periodTo = periodFrom + termMonths`
 *      using the same direct-UTC month arithmetic as `mark-paid-offline`
 *      (`setUTCMonth(+N)`; Asia/Bangkok is UTC+7 with no DST so the UTC
 *      instant lands at the same Bangkok calendar date — NO js-joda
 *      drift, matching the existing repo arithmetic).
 *   4. `renewal_cycle_created` audit emit IN THE SAME tx after insert
 *      (Constitution Principle VIII — state↔audit atomicity).
 *
 * Pure Application — orchestrates Domain via port interfaces only. No
 * ORM / HTTP / framework / React imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { MemberId } from '@/modules/members';
import type {
  NewRenewalCycleInput,
  RenewalCycleRepo,
} from '../ports/renewal-cycle-repo';
import type { PlanLookupForRenewalPort } from '../ports/plan-lookup-for-renewal';
import type {
  RenewalActorRole,
  RenewalAuditEmitter,
} from '../ports/renewal-audit-emitter';
import { asCycleId, type CycleId, type RenewalCycle } from '../../domain/renewal-cycle';

export interface CreateCycleInTxDeps {
  readonly cyclesRepo: Pick<
    RenewalCycleRepo,
    'findActiveForMemberInTx' | 'insert'
  >;
  /** F8 → F2 plan-lookup; supplies the frozen price/term/tier. */
  readonly planLookup: PlanLookupForRenewalPort;
  readonly auditEmitter: RenewalAuditEmitter;
  /** Cycle-id generator (production: `() => asCycleId(randomUUID())`). */
  readonly idFactory: { cycleId(): CycleId };
}

export interface CreateCycleInTxInput {
  readonly tenantId: string;
  readonly memberId: string;
  /**
   * ISO 8601 UTC period anchor. Steady-state on-paid: prior.periodTo
   * (gapless). Import / onboarding: the member's registration_date.
   * Admin lapsed-comeback: the comeback instant.
   */
  readonly periodFrom: string;
  readonly planId: string;
  /** Audit/observability provenance. */
  readonly source: 'on_paid' | 'import' | 'onboarding' | 'admin_lapsed_comeback';
  readonly actorUserId: string | null;
  readonly actorRole: RenewalActorRole;
  readonly correlationId: string;
  /**
   * Initial cycle status. Defaults to `'upcoming'`. Slice 3's admin
   * lapsed-comeback path passes `'awaiting_payment'` so the fresh cycle
   * is immediately payable.
   */
  readonly startStatus?: 'upcoming' | 'awaiting_payment';
}

export type CreateCycleOutcome =
  | { readonly kind: 'created'; readonly cycle: RenewalCycle }
  | { readonly kind: 'skipped_active_exists' };

/**
 * Add `months` calendar months to an ISO-8601 UTC instant via direct
 * UTC arithmetic. Mirrors `mark-paid-offline.ts:deriveNewExpiresAt` —
 * Asia/Bangkok is UTC+7 with no DST, so `setUTCMonth(+N)` lands at the
 * same Bangkok calendar date for every supported plan term. NO js-joda
 * (would introduce drift vs the existing repo arithmetic).
 */
function addMonthsUtc(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

export async function createCycleInTx(
  deps: CreateCycleInTxDeps,
  tx: TenantTx,
  input: CreateCycleInTxInput,
): Promise<CreateCycleOutcome> {
  // 1. Idempotency — in-tx-visible guard (NEVER the connection-fresh
  //    variant; see Task 1.1). If the member already holds an active
  //    cycle (including an uncommitted prior-cycle that has NOT yet been
  //    flipped →completed in this tx), do nothing.
  const active = await deps.cyclesRepo.findActiveForMemberInTx(
    tx,
    input.tenantId,
    input.memberId,
  );
  if (active) {
    return { kind: 'skipped_active_exists' };
  }

  // 2. Frozen-price snapshot (FR-021a). The cycle freezes the resolved
  //    plan's price/term/tier at creation; a later catalogue price bump
  //    does NOT change this cycle's billing.
  const plan = await deps.planLookup.loadPlanFrozenFields({
    tenantId: input.tenantId,
    planId: input.planId,
  });
  if (plan.status !== 'found') {
    throw new Error(
      `createCycleInTx: plan "${input.planId}" not resolvable (status=${plan.status}) for member ${input.memberId} — refusing to create a cycle without a frozen price`,
    );
  }

  // 3. Gapless period derivation.
  const periodTo = addMonthsUtc(input.periodFrom, plan.plan.termMonths);

  const cycleId = deps.idFactory.cycleId();
  const newCycle: NewRenewalCycleInput = {
    tenantId: input.tenantId,
    cycleId,
    memberId: input.memberId,
    periodFrom: input.periodFrom,
    periodTo,
    cycleLengthMonths: plan.plan.termMonths,
    tierAtCycleStart: plan.plan.tierBucket,
    planIdAtCycleStart: input.planId,
    frozenPlanPriceThb: plan.plan.priceTHB,
    frozenPlanTermMonths: plan.plan.termMonths,
    ...(input.startStatus !== undefined ? { startStatus: input.startStatus } : {}),
  };
  const cycle = await deps.cyclesRepo.insert(tx, input.tenantId, newCycle);

  // 4. Audit in the SAME tx (Principle VIII). The payload matches the
  //    canonical `F8AuditPayloadShapes.renewal_cycle_created` shape.
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_cycle_created',
      payload: {
        cycle_id: asCycleId(cycleId),
        member_id: input.memberId as MemberId,
        tier_bucket: plan.plan.tierBucket,
        period_from: input.periodFrom,
        period_to: periodTo,
      },
    },
    {
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      correlationId: input.correlationId,
    },
  );

  return { kind: 'created', cycle };
}
