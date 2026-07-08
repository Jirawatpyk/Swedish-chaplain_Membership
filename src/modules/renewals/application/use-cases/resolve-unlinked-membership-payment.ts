/**
 * Renewal rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238)
 * — `resolveUnlinkedMembershipPaymentInTx` (the unlinked-invoice on-paid
 * hook).
 *
 * F4 fires `F4InvoicePaidEvent` for EVERY paid invoice (event-fee or
 * membership). Before this hook existed, `markCycleCompleteInTx`'s
 * `no_cycle_for_invoice` branch was a silent no-op whenever the paid
 * invoice was not the one F8 itself dispatched — an admin-created ad-hoc
 * membership invoice never anchored or renewed anything (bug F-1). This
 * hook classifies the payment via the shared `classifyMembershipPayment`
 * (the SAME classifier every settlement site consumes — one source of
 * truth) and settles the member's renewal state accordingly:
 *
 *   - `heal_no_cycle` — a member with zero cycle rows ever self-heals: a
 *     fresh cycle is created anchored at the payment month, closing the
 *     DV-18 members-without-cycle gap at exactly the right moment.
 *   - `first_payment` — the member's one-and-only cycle has never been
 *     anchored to a real payment; it is RE-ANCHORED (not completed) to
 *     the actual payment month, re-freezing the plan's frozen fields when
 *     the re-anchor crosses a fiscal-year boundary.
 *   - `renewal` — the open cycle completes (paid) and the next cycle is
 *     created gapless at `periodTo` (mirrors the steady-state
 *     `createNextCycleOnPaidInTx` seam).
 *   - `not_applicable` (erased / terminal_only) and a non-membership
 *     `invoiceSubject` are no-ops — the member's renewal state does not
 *     move.
 *
 * Every settlement branch writes state + emits its audit event in the
 * SAME tx as the payment (Constitution Principle VIII). Infra throws
 * propagate so F4's payment tx rolls back and the at-least-once webhook
 * retry (or admin retry) heals — this hook NEVER swallows a throw after
 * a write.
 *
 * Degraded-mode refusal: this hook must NEVER run outside F4's real
 * payment tx. `markCycleCompleteInTx`'s `allowUnlinkedResolution` flag
 * (defaulted `true` for the atomic in-tx path, forced `false` by the
 * `markCycleCompleteFromInvoicePaid` wrapper) enforces this — see that
 * file's docstring for the three sanctioned wrapper uses.
 *
 * Pure Application — orchestrates Domain via port interfaces only. No
 * ORM / HTTP / framework / React imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import type { F4InvoicePaidEvent, InvoiceId } from '@/modules/invoicing';
import type { MemberId } from '@/modules/members';
import { classifyMembershipPayment } from '../../domain/classify-membership-payment';
import { asCycleId, type RenewalCycle } from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
  type RenewalCycleRepo,
} from '../ports/renewal-cycle-repo';
import type { MemberRenewalFlagsRepo } from '../ports/member-renewal-flags-repo';
import type { MemberPlanLookupPort } from '../ports/member-plan-lookup-port';
import { createCycleInTx, type CreateCycleInTxDeps } from './create-cycle-in-tx';
import { paymentAnchorMonthStartUtc } from './_lib/payment-anchor-date';

export type UnlinkedResolutionOutcome =
  | { readonly kind: 'reanchored'; readonly cycleId: string }
  | { readonly kind: 'renewed'; readonly cycleId: string }
  | { readonly kind: 'healed'; readonly cycleId: string }
  | {
      readonly kind: 'skipped';
      readonly reason: 'event_invoice' | 'erased' | 'terminal_only' | 'race_lost';
    };

/**
 * Deps — extends `CreateCycleInTxDeps` (this hook calls `createCycleInTx`
 * for both the `heal_no_cycle` fresh-cycle path and the `renewal`
 * next-cycle rollover) plus the extra `RenewalCycleRepo` methods this
 * hook needs directly, plus the GDPR-erasure guard read. Mirrors the
 * established `CreateNextCycleOnPaidDeps` intersection pattern.
 */
export type ResolveUnlinkedMembershipPaymentDeps = CreateCycleInTxDeps & {
  readonly cyclesRepo: Pick<
    RenewalCycleRepo,
    | 'findActiveForMemberInTx'
    | 'insert'
    | 'countCyclesForMemberInTx'
    | 'findOpenCycleForMemberInTx'
    | 'reanchorPeriodInTx'
    | 'transitionStatus'
  >;
  readonly memberRenewalFlagsRepo: Pick<
    MemberRenewalFlagsRepo,
    'readReactivationGuardsInTx'
  >;
  /**
   * F8 → F3 member-plan lookup — `heal_no_cycle` has no other source for
   * the member's current plan (the cross-module `F4InvoicePaidEvent`
   * deliberately carries no `planId`; see its docstring on keeping the
   * cross-module surface minimal). Same port `admin-renew-lapsed-member`
   * uses to resolve the member's CURRENT plan for its own fresh-cycle
   * creation.
   */
  readonly memberPlanLookup: MemberPlanLookupPort;
};

const AUDIT_ACTOR = { actorUserId: null, actorRole: 'system' as const };

function correlationId(evt: F4InvoicePaidEvent): string {
  return `f4-paid:${evt.invoiceId}`;
}

/** Fold the vestigial `'reminded'` status into `'upcoming'` for the classifier — mirrors the domain docstring on `classifyMembershipPayment`. */
function toClassifierOpenCycle(
  cycle: RenewalCycle | null,
): { readonly status: 'upcoming' | 'awaiting_payment'; readonly anchoredAt: string | null } | null {
  if (!cycle) return null;
  return {
    status: cycle.status === 'awaiting_payment' ? 'awaiting_payment' : 'upcoming',
    anchoredAt: cycle.anchoredAt,
  };
}

export async function resolveUnlinkedMembershipPaymentInTx(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
): Promise<UnlinkedResolutionOutcome> {
  // Behaviour 1 — event-fee invoices never touch renewal state. Zero reads.
  if (evt.invoiceSubject !== 'membership') {
    return { kind: 'skipped', reason: 'event_invoice' };
  }

  // Behaviour 2 — GDPR-erased member (COMP-1 guard reused). Checked BEFORE
  // the cycle-count/open-cycle reads so an erased member costs exactly one
  // round-trip, not three.
  const guards = await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
    tx,
    evt.tenantId,
    evt.memberId,
  );
  const erased = guards?.erased === true;
  if (erased) {
    logger.info(
      { invoiceId: evt.invoiceId, tenantId: evt.tenantId, memberId: evt.memberId },
      '[resolve-unlinked-payment] GDPR-erased member — skipping auto-anchor/renew',
    );
    renewalsMetrics.unlinkedPaymentResolved('skipped');
    return { kind: 'skipped', reason: 'erased' };
  }

  const cycleCountForMember = await deps.cyclesRepo.countCyclesForMemberInTx(
    tx,
    evt.tenantId,
    evt.memberId,
  );
  const openCycle = await deps.cyclesRepo.findOpenCycleForMemberInTx(
    tx,
    evt.tenantId,
    evt.memberId,
  );

  const classification = classifyMembershipPayment({
    cycleCountForMember,
    openCycle: toClassifierOpenCycle(openCycle),
    memberErased: false, // already handled above
  });

  switch (classification.kind) {
    case 'not_applicable': {
      // Only reachable with reason='terminal_only' here — 'erased' already
      // returned above. Members with only terminal cycles are owned by the
      // admin-comeback flow (loud log per design doc).
      logger.warn(
        {
          invoiceId: evt.invoiceId,
          tenantId: evt.tenantId,
          memberId: evt.memberId,
          reason: classification.reason,
        },
        '[resolve-unlinked-payment] member has only terminal cycles — payment does not affect renewal state (use admin-comeback flow)',
      );
      renewalsMetrics.unlinkedPaymentResolved('skipped');
      return { kind: 'skipped', reason: classification.reason };
    }
    case 'heal_no_cycle':
      return healNoCycle(deps, evt, tx);
    case 'first_payment':
      if (!openCycle) {
        // Invariant: classifyMembershipPayment only returns 'first_payment'
        // when openCycle !== null.
        throw new Error(
          `resolveUnlinkedMembershipPaymentInTx: classifier returned first_payment with no open cycle (invoice ${evt.invoiceId})`,
        );
      }
      return firstPayment(deps, evt, tx, openCycle);
    case 'renewal':
      if (!openCycle) {
        throw new Error(
          `resolveUnlinkedMembershipPaymentInTx: classifier returned renewal with no open cycle (invoice ${evt.invoiceId})`,
        );
      }
      return renewalComplete(deps, evt, tx, openCycle);
  }
}

/**
 * Behaviour 3 — zero-cycle member self-heal. Creates a fresh cycle
 * anchored at the payment month, then stamps `anchored_at` /
 * `anchor_invoice_id` on that SAME fresh row via `reanchorPeriodInTx` —
 * one code path for stamping (shared with the `first_payment` branch).
 * The guard (unanchored + status IN active-set) always passes here: we
 * just inserted this exact row inside THIS tx with `anchoredAt=NULL` and
 * `status='upcoming'`, and no other tx can see (let alone mutate) an
 * uncommitted row.
 */
async function healNoCycle(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
): Promise<UnlinkedResolutionOutcome> {
  const member = await deps.memberPlanLookup.loadMemberPlanInTx(
    tx,
    evt.tenantId,
    evt.memberId,
  );
  if (!member) {
    // Should be unreachable — the invoice's member FK guarantees the row
    // exists in this tenant. Throw so F4's tx rolls back and the anomaly
    // surfaces loudly rather than silently dropping the heal.
    throw new Error(
      `resolveUnlinkedMembershipPaymentInTx: heal_no_cycle could not resolve member ${evt.memberId}'s current plan (invoice ${evt.invoiceId})`,
    );
  }

  const anchorDate = paymentAnchorMonthStartUtc(evt);
  const createDeps: CreateCycleInTxDeps = {
    cyclesRepo: deps.cyclesRepo,
    planLookup: deps.planLookup,
    auditEmitter: deps.auditEmitter,
    idFactory: deps.idFactory,
  };
  const created = await createCycleInTx(createDeps, tx, {
    tenantId: evt.tenantId,
    memberId: evt.memberId,
    periodFrom: anchorDate,
    planId: member.planId,
    startStatus: 'upcoming',
    actorUserId: AUDIT_ACTOR.actorUserId,
    actorRole: AUDIT_ACTOR.actorRole,
    correlationId: correlationId(evt),
  });

  if (created.kind === 'skipped_active_exists') {
    // Lost a race against a concurrent path that created an active cycle
    // for this member between our classification read and this insert
    // attempt (e.g. a different invoice paid for the same member in a
    // separate, concurrent tx). Re-read + reclassify once.
    return reclassifyAfterRace(deps, evt, tx);
  }

  const stamped = await deps.cyclesRepo.reanchorPeriodInTx(
    tx,
    evt.tenantId,
    created.cycle.cycleId,
    {
      periodFrom: created.cycle.periodFrom,
      periodTo: created.cycle.periodTo,
      anchoredAt: anchorDate,
      anchorInvoiceId: evt.invoiceId,
      frozenPlanPriceThb: created.cycle.frozenPlanPriceThb,
      frozenPlanTermMonths: created.cycle.frozenPlanTermMonths,
    },
  );
  if (!stamped) {
    // Should be unreachable — we hold the only reference to this
    // freshly-inserted, still-uncommitted row within this tx. A null
    // here is an infra anomaly, not a real race; throw loudly.
    throw new Error(
      `resolveUnlinkedMembershipPaymentInTx: heal_no_cycle anchor-stamp failed for freshly-created cycle ${created.cycle.cycleId}`,
    );
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_cycle_reanchored',
      payload: {
        cycle_id: asCycleId(created.cycle.cycleId),
        member_id: evt.memberId as MemberId,
        invoice_id: evt.invoiceId as InvoiceId,
        old_period_from: null,
        old_period_to: null,
        new_period_from: stamped.cycle.periodFrom,
        new_period_to: stamped.cycle.periodTo,
        old_status: 'none',
        refroze_plan_fields: false,
        reminder_events_reset: stamped.reminderEventsReset,
      },
    },
    { tenantId: evt.tenantId, ...AUDIT_ACTOR, correlationId: correlationId(evt) },
  );

  renewalsMetrics.unlinkedPaymentResolved('healed');
  return { kind: 'healed', cycleId: created.cycle.cycleId };
}

/**
 * Behaviour 4 — re-anchor the member's one-and-only, never-anchored
 * cycle to the ACTUAL payment month. Re-freezes the plan's frozen fields
 * when the re-anchor crosses a fiscal-year boundary; an unresolvable
 * plan (catalogue gap) keeps the old frozen fields + a loud log rather
 * than failing the payment.
 */
async function firstPayment(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
  cycle: RenewalCycle,
): Promise<UnlinkedResolutionOutcome> {
  const anchorDate = paymentAnchorMonthStartUtc(evt);

  const oldFiscalYear = deriveFiscalYear(cycle.periodFrom);
  const newFiscalYear = deriveFiscalYear(anchorDate);

  let frozenPlanPriceThb = cycle.frozenPlanPriceThb;
  let frozenPlanTermMonths = cycle.frozenPlanTermMonths;
  let refrozePlanFields = false;

  if (newFiscalYear !== oldFiscalYear) {
    const resolved = await deps.planLookup.loadPlanFrozenFields({
      tenantId: evt.tenantId,
      planId: cycle.planIdAtCycleStart,
      fiscalYear: newFiscalYear,
      mode: 'freeze',
    });
    if (resolved.status === 'found') {
      frozenPlanPriceThb = resolved.plan.priceTHB;
      frozenPlanTermMonths = resolved.plan.termMonths;
      refrozePlanFields = true;
    } else {
      logger.error(
        {
          cycleId: cycle.cycleId,
          planId: cycle.planIdAtCycleStart,
          newFiscalYear,
          status: resolved.status,
        },
        '[resolve-unlinked-payment] first-payment re-anchor crossed a fiscal-year boundary but the plan is unresolvable for the new year — keeping old frozen fields',
      );
    }
  }

  const newPeriodTo = addMonthsUtc(anchorDate, frozenPlanTermMonths);

  const reanchored = await deps.cyclesRepo.reanchorPeriodInTx(
    tx,
    evt.tenantId,
    cycle.cycleId,
    {
      periodFrom: anchorDate,
      periodTo: newPeriodTo,
      anchoredAt: anchorDate,
      anchorInvoiceId: evt.invoiceId,
      frozenPlanPriceThb,
      frozenPlanTermMonths,
    },
  );
  if (!reanchored) {
    // Lost the anchor race — re-read + reclassify once (design rev 2 §2).
    return reclassifyAfterRace(deps, evt, tx);
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_cycle_reanchored',
      payload: {
        cycle_id: asCycleId(cycle.cycleId),
        member_id: cycle.memberId as MemberId,
        invoice_id: evt.invoiceId as InvoiceId,
        old_period_from: cycle.periodFrom,
        old_period_to: cycle.periodTo,
        new_period_from: reanchored.cycle.periodFrom,
        new_period_to: reanchored.cycle.periodTo,
        old_status: cycle.status,
        refroze_plan_fields: refrozePlanFields,
        reminder_events_reset: reanchored.reminderEventsReset,
      },
    },
    { tenantId: evt.tenantId, ...AUDIT_ACTOR, correlationId: correlationId(evt) },
  );

  renewalsMetrics.unlinkedPaymentResolved('reanchored');
  return { kind: 'reanchored', cycleId: cycle.cycleId };
}

/**
 * Behaviour 5 — the open cycle completes (paid) and the next cycle is
 * created gapless at `periodTo` (mirrors `createNextCycleOnPaidInTx`'s
 * steady-state next-cycle creation). If the cycle was linked to a
 * DIFFERENT invoice (a dispatched renewal invoice orphaned by this
 * out-of-band payment), logs loudly for staff to void it — never
 * auto-voided.
 *
 * A lost race on the completion transition (a concurrent path already
 * moved the cycle out of its expected status) is treated as an
 * idempotent skip, NOT an infra failure — the paying invoice's OWN
 * payment already succeeded; we just could not win the cycle-side
 * bookkeeping race. Mirrors `autoComplete`'s existing
 * CycleTransitionConflictError / CycleNotFoundError handling.
 */
async function renewalComplete(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
  cycle: RenewalCycle,
): Promise<UnlinkedResolutionOutcome> {
  if (cycle.linkedInvoiceId !== null && cycle.linkedInvoiceId !== evt.invoiceId) {
    logger.error(
      {
        cycleId: cycle.cycleId,
        orphanedInvoiceId: cycle.linkedInvoiceId,
        payingInvoiceId: evt.invoiceId,
        tenantId: evt.tenantId,
        memberId: evt.memberId,
      },
      '[resolve-unlinked-payment] orphaned dispatched invoice — staff must void',
    );
  }

  let updated: RenewalCycle;
  try {
    updated = await deps.cyclesRepo.transitionStatus(tx, evt.tenantId, cycle.cycleId, {
      from: cycle.status,
      to: 'completed',
      closedAt: evt.paidAt,
      closedReason: 'paid',
      linkedInvoiceId: evt.invoiceId,
    });
  } catch (e) {
    if (e instanceof CycleTransitionConflictError || e instanceof CycleNotFoundError) {
      logger.warn(
        { cycleId: cycle.cycleId, err: e.message },
        '[resolve-unlinked-payment] renewal-complete lost race — idempotent skip',
      );
      renewalsMetrics.unlinkedPaymentResolved('skipped');
      return { kind: 'skipped', reason: 'race_lost' };
    }
    throw e;
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_completed' as const,
      payload: {
        cycle_id: updated.cycleId,
        member_id: cycle.memberId,
        invoice_id: evt.invoiceId,
        paid_at: evt.paidAt,
        amount_satang: evt.amountSatang.toString(),
        payment_method: evt.paymentMethod,
      },
    },
    { tenantId: evt.tenantId, ...AUDIT_ACTOR, correlationId: correlationId(evt) },
  );

  const createDeps: CreateCycleInTxDeps = {
    cyclesRepo: deps.cyclesRepo,
    planLookup: deps.planLookup,
    auditEmitter: deps.auditEmitter,
    idFactory: deps.idFactory,
  };
  // Mirrors create-next-cycle-on-paid.ts's exact call: gapless next cycle
  // anchored at the just-completed cycle's periodTo. `createCycleInTx`'s
  // in-tx idempotency guard (`findActiveForMemberInTx`) sees the
  // uncommitted completion flip above and correctly excludes it, so the
  // next cycle IS created on first delivery.
  await createCycleInTx(createDeps, tx, {
    tenantId: evt.tenantId,
    memberId: cycle.memberId,
    periodFrom: cycle.periodTo,
    planId: cycle.planIdAtCycleStart,
    actorUserId: AUDIT_ACTOR.actorUserId,
    actorRole: AUDIT_ACTOR.actorRole,
    correlationId: `on-paid:${evt.invoiceId}`,
  });

  renewalsMetrics.unlinkedPaymentResolved('renewed');
  return { kind: 'renewed', cycleId: cycle.cycleId };
}

/**
 * Shared race-recovery for `heal_no_cycle` (lost the active-cycle-create
 * race) and `first_payment` (lost the anchor-guard race): re-read the
 * member's open cycle + reclassify EXACTLY ONCE. A `renewal`
 * reclassification falls through to `renewalComplete`; anything else
 * (including a repeat first_payment/heal_no_cycle result, which would
 * indicate a genuinely pathological retry storm) is reported as
 * `skipped:race_lost` rather than looping.
 */
async function reclassifyAfterRace(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
): Promise<UnlinkedResolutionOutcome> {
  const cycleCountForMember = await deps.cyclesRepo.countCyclesForMemberInTx(
    tx,
    evt.tenantId,
    evt.memberId,
  );
  const openCycle = await deps.cyclesRepo.findOpenCycleForMemberInTx(
    tx,
    evt.tenantId,
    evt.memberId,
  );
  const reclassified = classifyMembershipPayment({
    cycleCountForMember,
    openCycle: toClassifierOpenCycle(openCycle),
    memberErased: false,
  });

  if (reclassified.kind === 'renewal' && openCycle) {
    return renewalComplete(deps, evt, tx, openCycle);
  }

  logger.warn(
    {
      invoiceId: evt.invoiceId,
      tenantId: evt.tenantId,
      memberId: evt.memberId,
      reclassifiedAs: reclassified.kind,
    },
    '[resolve-unlinked-payment] lost a create/re-anchor race and the re-read did not resolve to a renewal — skipping',
  );
  renewalsMetrics.unlinkedPaymentResolved('skipped');
  return { kind: 'skipped', reason: 'race_lost' };
}
