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
import {
  createCycleInTx,
  PlanNotResolvableError,
  type CreateCycleInTxDeps,
  type CreateCycleOutcome,
} from './create-cycle-in-tx';
import { paymentAnchorMonthStartUtc } from './_lib/payment-anchor-date';
import { reanchorFirstPaymentCycleInTx } from './_lib/reanchor-first-payment';

export type UnlinkedResolutionOutcome =
  | { readonly kind: 'reanchored'; readonly cycleId: string }
  | { readonly kind: 'renewed'; readonly cycleId: string }
  | { readonly kind: 'healed'; readonly cycleId: string }
  /**
   * FR-005b parity fix (Task 5 review F4) — the blocked-member counterpart
   * to `'renewed'`. Emitted by `heldForAdminReview` when the renewal
   * branch's member has `blocked_from_auto_reactivation = true`; the open
   * cycle is routed to `pending_admin_reactivation` instead of completed.
   */
  | { readonly kind: 'held_pending_admin'; readonly cycleId: string }
  | {
      readonly kind: 'skipped';
      readonly reason:
        | 'event_invoice'
        | 'erased'
        | 'terminal_only'
        | 'race_lost'
        /**
         * F1 fix (Task 5 review) — `healNoCycle`'s `createCycleInTx` call
         * hit a catalogue gap (`PlanNotResolvableError`: the member's plan
         * is not_found/plan_inactive). The payment stands (it already
         * succeeded independent of any specific plan resolution); the
         * dispatcher skip-guard + reconciliation surface the member for
         * admin follow-up rather than rolling back a real payment over a
         * catalogue data problem.
         */
        | 'plan_unresolvable';
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
    | 'countSettledCyclesForMemberInTx'
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
  // FR-005b parity (Task 5 review F4) — read alongside `erased` above (same
  // round-trip, COMP-1 L3 fold). Used below to gate the `renewal` branch
  // the same way `markCycleCompleteInTx`'s `holdForAdminReview` gates the
  // LINKED path.
  const blocked = guards?.blocked === true;

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
  // F2 fix (final-review, 2026-07-09) — SETTLED history (completed OR
  // ever-anchored), not raw cycle count, discriminates first_payment vs
  // renewal (see classify-membership-payment.ts docstring). Only queried
  // when an open cycle exists — `classifyMembershipPayment` never
  // consults it otherwise (heal_no_cycle / terminal_only branches).
  const settledCycleCountForMember = openCycle
    ? await deps.cyclesRepo.countSettledCyclesForMemberInTx(
        tx,
        evt.tenantId,
        evt.memberId,
        openCycle.cycleId,
      )
    : 0;

  const classification = classifyMembershipPayment({
    cycleCountForMember,
    settledCycleCountForMember,
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
      return healNoCycle(deps, evt, tx, blocked);
    case 'first_payment':
      if (!openCycle) {
        // Invariant: classifyMembershipPayment only returns 'first_payment'
        // when openCycle !== null.
        throw new Error(
          `resolveUnlinkedMembershipPaymentInTx: classifier returned first_payment with no open cycle (invoice ${evt.invoiceId})`,
        );
      }
      return firstPayment(deps, evt, tx, openCycle, blocked);
    case 'renewal':
      if (!openCycle) {
        throw new Error(
          `resolveUnlinkedMembershipPaymentInTx: classifier returned renewal with no open cycle (invoice ${evt.invoiceId})`,
        );
      }
      // FR-005b parity (Task 5 review F4) — a blocked member must NOT
      // auto-complete via this unlinked branch; route to admin review the
      // same way the linked path's `holdForAdminReview` does.
      if (blocked) {
        return heldForAdminReview(deps, evt, tx, openCycle);
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
  blocked: boolean,
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
  // F1 fix (Task 5 review, Critical) — a catalogue gap (the member's plan
  // is not_found/plan_inactive) must NOT block the payment. Unlike
  // `renewalComplete`'s next-cycle creation (see that function's docstring
  // for the deliberately asymmetric NEVER-swallow rationale), the heal
  // branch's payment already succeeded independent of any specific plan
  // resolution — there is no "renewal" being paid for yet, just a
  // zero-cycle member who needs *a* cycle. Rolling back a real payment
  // over a catalogue data problem would be worse than skipping the heal
  // and letting the dispatcher skip-guard + reconciliation surface the
  // member for admin follow-up.
  let created: CreateCycleOutcome;
  try {
    created = await createCycleInTx(createDeps, tx, {
      tenantId: evt.tenantId,
      memberId: evt.memberId,
      periodFrom: anchorDate,
      planId: member.planId,
      startStatus: 'upcoming',
      actorUserId: AUDIT_ACTOR.actorUserId,
      actorRole: AUDIT_ACTOR.actorRole,
      correlationId: correlationId(evt),
    });
  } catch (e) {
    if (e instanceof PlanNotResolvableError) {
      logger.error(
        {
          tenantId: evt.tenantId,
          memberId: evt.memberId,
          invoiceId: evt.invoiceId,
          planId: e.planId,
          planStatus: e.planStatus,
        },
        '[resolve-unlinked-payment] heal: plan unresolvable — skipping (payment stands; dispatcher skip-guard will surface the member)',
      );
      renewalsMetrics.unlinkedPaymentResolved('skipped');
      return { kind: 'skipped', reason: 'plan_unresolvable' };
    }
    throw e;
  }

  if (created.kind === 'skipped_active_exists') {
    // Lost a race against a concurrent path that created an active cycle
    // for this member between our classification read and this insert
    // attempt (e.g. a different invoice paid for the same member in a
    // separate, concurrent tx). Re-read + reclassify once.
    return reclassifyAfterRace(deps, evt, tx, blocked);
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
 * cycle to the ACTUAL payment month. Delegates the shared re-anchor core
 * (month-start anchor date, FY-crossing frozen-field re-resolution, the
 * guarded `reanchorPeriodInTx` UPDATE, audit + metric) to
 * `reanchorFirstPaymentCycleInTx` — Task 6 extracted this so
 * `markCycleCompleteInTx`'s linked-path first-payment branch shares the
 * SAME implementation rather than duplicating it.
 */
async function firstPayment(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
  cycle: RenewalCycle,
  blocked: boolean,
): Promise<UnlinkedResolutionOutcome> {
  const result = await reanchorFirstPaymentCycleInTx(deps, evt, tx, cycle);
  if (!result) {
    // Lost the anchor race — re-read + reclassify once (design rev 2 §2).
    return reclassifyAfterRace(deps, evt, tx, blocked);
  }
  return { kind: 'reanchored', cycleId: result.cycle.cycleId };
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
    // F4 (final-review, 2026-07-09, defensive) — `reminded` has NO direct
    // edge into `completed` (`TRANSITIONS.reminded = ['awaiting_payment',
    // 'cancelled']` in `cycle-status.ts`) — only `upcoming` (offline-mark
    // shortcut) and `awaiting_payment` do. Passing raw `cycle.status`
    // straight through for a `reminded` cycle would throw
    // `InvalidCycleTransitionError` (uncaught by the
    // CycleTransitionConflictError/CycleNotFoundError catch below),
    // crashing this hook instead of completing the payment. Take the
    // SAME legal two-step route `heldForAdminReview` already uses for
    // `upcoming|reminded → awaiting_payment` a few lines down.
    // `reminded` has NO writer anywhere in `src/` today (vestigial status
    // — see `classify-membership-payment.ts`'s module docstring), so this
    // branch is currently unreachable in production; written defensively
    // so a future writer doesn't reintroduce this crash.
    if (cycle.status === 'reminded') {
      await deps.cyclesRepo.transitionStatus(tx, evt.tenantId, cycle.cycleId, {
        from: 'reminded',
        to: 'awaiting_payment',
      });
      updated = await deps.cyclesRepo.transitionStatus(tx, evt.tenantId, cycle.cycleId, {
        from: 'awaiting_payment',
        to: 'completed',
        closedAt: evt.paidAt,
        closedReason: 'paid',
        linkedInvoiceId: evt.invoiceId,
      });
    } else {
      updated = await deps.cyclesRepo.transitionStatus(tx, evt.tenantId, cycle.cycleId, {
        from: cycle.status,
        to: 'completed',
        closedAt: evt.paidAt,
        closedReason: 'paid',
        linkedInvoiceId: evt.invoiceId,
      });
    }
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
  //
  // Deliberately NOT wrapped in a try/catch for `PlanNotResolvableError`
  // (asymmetric to `healNoCycle`'s guard above — see F1 fix comment
  // there). `create-next-cycle-on-paid.ts`'s docstring is explicit: "THROWS
  // on any failure ... NEVER swallow — a swallow would commit the payment
  // while the member silently drops out of the renewal pipeline with no
  // retry trigger." A catalogue gap discovered while COMPLETING a renewal
  // is a real ops incident (the plan the member just paid to renew no
  // longer resolves) and must roll back the whole tx so the at-least-once
  // retry / webhook redelivery surfaces it loudly — unlike the heal
  // branch, where the payment already succeeded independent of any
  // specific plan and there is no renewal state to roll back.
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
 * FR-005b parity fix (Task 5 review F4) — the blocked-member counterpart
 * to `renewalComplete`. Mirrors `markCycleCompleteInTx`'s
 * `holdForAdminReview` gate on the LINKED path: a member with
 * `blocked_from_auto_reactivation = true` must not silently auto-complete
 * via this UNLINKED hook either. The open cycle is routed to
 * `pending_admin_reactivation` instead of `completed`, and — unlike
 * `renewalComplete` — NO next cycle is created; the admin decides what
 * happens next via the existing T136/T137/T138 admin-review actions.
 *
 * `awaiting_payment` cycles transition directly (the same single legal
 * edge `holdForAdminReview` uses). `upcoming`/`reminded` cycles have no
 * direct edge into `pending_admin_reactivation` (see `TRANSITIONS` in
 * `cycle-status.ts` — only `awaiting_payment` and `lapsed` do), so they
 * take the two legal steps in the SAME tx:
 * `upcoming|reminded → awaiting_payment → pending_admin_reactivation`.
 * (`classifyMembershipPayment` only ever hands this branch `upcoming` or
 * `awaiting_payment` — `reminded` is declared-but-never-written per that
 * module's docstring — but the two-step guard is written generically over
 * "not already awaiting_payment" so it stays correct if that changes.)
 *
 * A lost race on either transition step is treated as an idempotent skip,
 * NOT an infra failure, mirroring `renewalComplete`'s own
 * `CycleTransitionConflictError` / `CycleNotFoundError` handling — the
 * paying invoice's OWN payment already succeeded independent of the
 * cycle-side bookkeeping race.
 */
async function heldForAdminReview(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
  cycle: RenewalCycle,
): Promise<UnlinkedResolutionOutcome> {
  try {
    if (cycle.status !== 'awaiting_payment') {
      await deps.cyclesRepo.transitionStatus(tx, evt.tenantId, cycle.cycleId, {
        from: cycle.status,
        to: 'awaiting_payment',
      });
    }
    await deps.cyclesRepo.transitionStatus(tx, evt.tenantId, cycle.cycleId, {
      from: 'awaiting_payment',
      to: 'pending_admin_reactivation',
      enteredPendingAt: evt.paidAt,
      linkedInvoiceId: evt.invoiceId,
    });
  } catch (e) {
    if (e instanceof CycleTransitionConflictError || e instanceof CycleNotFoundError) {
      logger.warn(
        { cycleId: cycle.cycleId, err: e.message },
        '[resolve-unlinked-payment] held-for-admin lost race — idempotent skip',
      );
      renewalsMetrics.unlinkedPaymentResolved('skipped');
      return { kind: 'skipped', reason: 'race_lost' };
    }
    throw e;
  }

  // Payload shape copied verbatim from `holdForAdminReview` in
  // mark-cycle-complete-from-invoice-paid.ts (the LINKED path's twin).
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_completed_post_lapse' as const,
      payload: {
        cycle_id: cycle.cycleId,
        member_id: cycle.memberId,
        invoice_id: evt.invoiceId,
        held_for_admin_review: true,
      },
    },
    { tenantId: evt.tenantId, ...AUDIT_ACTOR, correlationId: correlationId(evt) },
  );

  renewalsMetrics.unlinkedPaymentResolved('held');
  return { kind: 'held_pending_admin', cycleId: cycle.cycleId };
}

/**
 * Shared race-recovery for `heal_no_cycle` (lost the active-cycle-create
 * race) and `first_payment` (lost the anchor-guard race): re-read the
 * member's open cycle + reclassify EXACTLY ONCE. A `renewal`
 * reclassification falls through to `renewalComplete` (or, when the member
 * is `blocked_from_auto_reactivation`, `heldForAdminReview` — FR-005b parity
 * fix, Task 5 review F4 residual R1: the double-race fallback previously
 * skipped this check and could auto-complete a blocked member); anything
 * else (including a repeat first_payment/heal_no_cycle result, which would
 * indicate a genuinely pathological retry storm) is reported as
 * `skipped:race_lost` rather than looping.
 *
 * `blocked` is threaded from the ORIGINAL `readReactivationGuardsInTx` read
 * at the top of `resolveUnlinkedMembershipPaymentInTx` — a member's
 * admin-set flag cannot change mid-tx (no writer other than the dedicated
 * block/unblock use-cases, which take their own tenant lock), so re-reading
 * it here would be redundant.
 */
async function reclassifyAfterRace(
  deps: ResolveUnlinkedMembershipPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
  blocked: boolean,
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
  // F2 fix (final-review, 2026-07-09) — see the main function's identical
  // comment above.
  const settledCycleCountForMember = openCycle
    ? await deps.cyclesRepo.countSettledCyclesForMemberInTx(
        tx,
        evt.tenantId,
        evt.memberId,
        openCycle.cycleId,
      )
    : 0;
  const reclassified = classifyMembershipPayment({
    cycleCountForMember,
    settledCycleCountForMember,
    openCycle: toClassifierOpenCycle(openCycle),
    memberErased: false,
  });

  if (reclassified.kind === 'renewal' && openCycle) {
    if (blocked) {
      return heldForAdminReview(deps, evt, tx, openCycle);
    }
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
