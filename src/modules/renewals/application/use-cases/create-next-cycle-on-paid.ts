/**
 * F8-completion Slice 1 · Task 1.4 — `createNextCycleOnPaidInTx`.
 *
 * The steady-state cycle-creation seam. Runs as `f8OnPaidCallbacks[2]`,
 * AFTER callback[0] (`markCycleComplete`) has flipped the just-paid
 * prior cycle `→completed` in the SAME F4 record-payment tx (the
 * callbacks fire sequentially in registration order — see
 * `record-payment.ts` + `F4InvoicePaidEvent` doc).
 *
 * Thin wrapper over `createCycleInTx`:
 *   1. Resolve the just-paid cycle by linked invoice id
 *      (`findByInvoiceIdInTx`). Null ⇒ the paid invoice is not a renewal
 *      invoice (ad-hoc admin / event-fee) ⇒ no-op.
 *   2. Anchor the next cycle at `prior.periodTo` (gapless) and delegate
 *      to `createCycleInTx`.
 *
 * Because callback[0] flipped the prior cycle `→completed` in THIS tx,
 * `createCycleInTx`'s in-tx idempotency guard (`findActiveForMemberInTx`)
 * correctly EXCLUDES the prior cycle (it sees the uncommitted
 * completion) — so the next cycle IS created on the FIRST (non-retry)
 * delivery. A connection-fresh read would still see the prior cycle as
 * active and no-op (the happy-path-DEAD bug Task 1.1 prevents).
 *
 * THROWS on any GENUINE failure (prior lookup / insert / audit). This is
 * in-tx state work: a throw propagates out of the F4 record-payment tx →
 * the whole tx rolls back → the F4 invoice stays `issued` → the Stripe
 * at-least-once webhook retry re-runs the chain, which heals idempotently.
 * NEVER swallow — a swallow would commit the payment while the member
 * silently drops out of the renewal pipeline with no retry trigger.
 *
 * Plan-change -> billing remediation (Package A): the next cycle is now
 * seeded from the member's LIVE plan (`members.plan_id`) via
 * `seedNextCycleFromMemberPlanInTx`, NOT the prior cycle's plan. The ONE
 * exception to the never-swallow rule is cohort E — the member's live plan
 * has no catalogue row resolvable for the next cycle's fiscal year — which
 * the helper handles by falling back to the prior plan + a forensic audit
 * (never a rollback). See that helper's docstring.
 *
 * Pure Application — port interfaces only (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import type { RenewalCycleRepo } from '../ports/renewal-cycle-repo';
import {
  seedNextCycleFromMemberPlanInTx,
  type SeedNextCycleFromMemberPlanDeps,
} from './_lib/seed-next-cycle-from-member-plan';

export type CreateNextCycleOnPaidDeps = SeedNextCycleFromMemberPlanDeps & {
  readonly cyclesRepo: Pick<
    RenewalCycleRepo,
    'findByInvoiceIdInTx' | 'findActiveForMemberInTx' | 'insert'
  >;
};

export async function createNextCycleOnPaidInTx(
  deps: CreateNextCycleOnPaidDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
): Promise<void> {
  // 1. Resolve the just-paid cycle. Null ⇒ not a renewal invoice ⇒ no-op.
  const prior = await deps.cyclesRepo.findByInvoiceIdInTx(
    tx,
    evt.tenantId,
    evt.invoiceId,
  );
  if (!prior) {
    return;
  }

  // 2. Gapless next cycle, seeded from the member's LIVE plan (Package A).
  //    `createCycleInTx` (called inside the helper) no-ops if the member
  //    still has an active cycle — but callback[0] flipped `prior`
  //    →completed in THIS tx, so `findActiveForMemberInTx` (in-tx-visible)
  //    excludes it and the new cycle IS created on first delivery.
  //    F4InvoicePaidEvent carries no correlationId — derive a
  //    deterministic one from the invoice id for log/trace correlation.
  await seedNextCycleFromMemberPlanInTx(deps, tx, {
    tenantId: evt.tenantId,
    memberId: prior.memberId,
    periodFrom: prior.periodTo,
    priorPlanId: prior.planIdAtCycleStart,
    actorUserId: null,
    actorRole: 'system',
    correlationId: `on-paid:${evt.invoiceId}`,
  });
  // Any GENUINE throw above propagates → F4 tx rolls back → Stripe retry
  // heals. Cohort E (live plan unresolvable) is handled by the helper: it
  // falls back to the prior plan + emits an audit, never a rollback.
}
