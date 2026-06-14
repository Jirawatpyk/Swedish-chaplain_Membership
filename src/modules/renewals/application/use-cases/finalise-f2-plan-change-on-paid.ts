/**
 * F2 scheduled-plan-change finalisation — the POST-commit half of the
 * tier-upgrade-apply cascade. Single source of truth for both:
 *   - the ONLINE F4 invoice-paid callback (`f8OnPaidCallbacks[1]` via
 *     `infrastructure/_lib/apply-tier-upgrade-on-paid-callback.ts`), and
 *   - the OFFLINE admin mark-paid path (070 Item D, `mark-paid-offline.ts`).
 *
 * Runs in its OWN `runInTenant` tx — SEPARATE from the F4/offline state
 * tx. By the time this runs the caller's state tx has already committed
 * (suggestion → applied + cycle flipped + next cycle created), so this
 * F2 flip is eventual-consistent + non-rollback: any failure here is
 * logged + swallowed (the caller's state is durable; the F2 row stays
 * `pending` for a retry to heal). Mirrors the post-tx F2 emit pattern
 * in `accept-tier-upgrade.ts`.
 *
 * Two-phase money-safety gate (065 Fix A precision — preserved verbatim
 * from the Infrastructure helper this extraction replaces):
 *   1. Resolve the single pending `scheduled_plan_changes` row for the
 *      (member, cycle). No pending row ⇒ no-op (same-tier renewal).
 *   2. Parse the pending row's `reason` (`tier_upgrade_accepted:<id>`)
 *      back to its originating suggestion + resolve THAT suggestion's
 *      status. Skip ONLY when it is `superseded` (the cancelled-upgrade
 *      orphan that must NOT be re-billed — the original S6 money bug).
 *      Standalone schedules (no suggestion link) + applied / pending
 *      suggestions proceed.
 *
 * Pure Application — port interfaces only (Constitution Principle III).
 */
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseSuggestionIdFromReason } from '../../domain/tier-upgrade-suggestion';

/**
 * Actor for the F2 `plan_change_applied` audit. The F2 `AuditPort` has
 * no `actorRole` field — only `actorUserId` (an F1 user UUID OR a
 * `'system:…'` sentinel). The ONLINE F4 invoice-paid path uses the
 * `'system:f8-on-paid-webhook'` sentinel (the cascade fires from the F4
 * webhook contract); the OFFLINE admin mark-paid path (070 Item D)
 * passes the admin's user id, since the admin initiated the settlement.
 */
export interface FinaliseF2Actor {
  readonly actorUserId: string;
  readonly requestId: string;
}

/**
 * Default ONLINE actor — the F4 invoice-paid webhook cascade. Mirrors
 * the F1 audit `'system:webhook'` / `'system:cron'` sentinel pattern;
 * the F2 `AuditContext.actorUserId` is a required `string`.
 */
export function defaultOnlineF2Actor(evt: F4InvoicePaidEvent): FinaliseF2Actor {
  return {
    actorUserId: 'system:f8-on-paid-webhook',
    requestId: `f8-onPaid:${evt.invoiceId}`,
  };
}

export async function finaliseF2PlanChangeOnPaid(
  deps: RenewalsDeps,
  evt: F4InvoicePaidEvent,
  cycleId: string,
  actor: FinaliseF2Actor,
): Promise<void> {
  const memberId = evt.memberId as unknown as string;

  let pending;
  try {
    pending = await deps.scheduledPlanChangeRepo.findPendingForCycle(
      deps.tenant,
      memberId,
      cycleId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: evt.tenantId,
        memberId,
        cycleId,
        invoiceId: evt.invoiceId,
        errorId: 'F2.PLAN_CHANGE.FIND_PENDING_FAILED',
      },
      '[on-paid] F2 scheduled-plan-change findPendingForCycle failed — caller state already committed; manual replay needed',
    );
    return;
  }

  // Cycles without a pending F2 scheduled-plan-change row (the common
  // case — same-tier renewal, no plan switch scheduled) are a no-op.
  // Idempotent on re-fire: already-applied rows return null from
  // `findPendingForCycle` (terminal-state semantics, partial-unique
  // guarantee).
  if (pending === null) return;

  // 065 Fix A precision — gate on the PENDING row's OWN linked suggestion
  // status, NOT a coarse cycle-wide superseded-existence probe. A member
  // can have TWO suggestions targeting the same active cycle (an upgrade
  // accepted → manually overridden [superseded, retains the cycle target]
  // → re-suggested + re-accepted). The cycle-wide gate matched the
  // SUPERSEDED suggestion1 and wrongly skipped the finaliser, stranding
  // suggestion2's VALID pending plan-change forever.
  //
  // The pending F2 row carries a `reason` of `tier_upgrade_accepted:<id>`
  // (written by `acceptTierUpgrade`); we resolve THAT suggestion and skip
  // ONLY when it is `superseded` (the cancelled-upgrade orphan that must
  // NOT be re-billed — the original S6 money bug). Standalone schedules
  // (reason not matching the prefix → null id) and applied / pending
  // suggestions proceed.
  const linkedSuggestionId = parseSuggestionIdFromReason(pending.reason);
  if (linkedSuggestionId !== null) {
    let linkedSuggestion;
    try {
      linkedSuggestion = await deps.tierUpgradeRepo.findById(
        evt.tenantId,
        linkedSuggestionId,
      );
    } catch (e) {
      // Money-safe default — when we cannot determine the linked
      // suggestion status (transient read failure), SKIP rather than risk
      // flipping a row whose upgrade may have been cancelled. A later
      // retry re-attempts once the read recovers (the F2 row stays
      // `pending` — strand, never over-bill).
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: evt.tenantId,
          memberId,
          cycleId,
          scheduledChangeId: pending.scheduledChangeId,
          suggestionId: linkedSuggestionId,
          invoiceId: evt.invoiceId,
          errorId: 'F2.PLAN_CHANGE.SUGGESTION_STATUS_LOOKUP_FAILED',
        },
        '[on-paid] F2 finaliser suggestion-status lookup failed — skipping finalise (money-safe); retry will heal',
      );
      return;
    }
    if (linkedSuggestion?.status === 'superseded') {
      // The upgrade this F2 row belongs to was cancelled by a manual
      // override. Flipping it pending → applied would re-bill the
      // cancelled upgrade — the S6 money bug. Skip (no transition, no
      // counter, no audit). The F2 row stays `pending` (terminal-orphan;
      // a future reconcile may cancel it).
      return;
    }
  }

  // The finaliser is about to flip the pending row → applied. Bump the SRE
  // signal HERE (co-located with the actual transition now that the skip
  // decision is per-row + needs the pending row in hand).
  renewalsMetrics.f2FinaliseBeforeF4Commit(evt.tenantId);

  let transitioned;
  try {
    transitioned = await deps.scheduledPlanChangeRepo.transitionStatus(
      deps.tenant,
      pending.scheduledChangeId,
      'applied',
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: evt.tenantId,
        memberId,
        cycleId,
        scheduledChangeId: pending.scheduledChangeId,
        invoiceId: evt.invoiceId,
        errorId: 'F2.PLAN_CHANGE.TRANSITION_APPLIED_FAILED',
      },
      '[on-paid] F2 scheduled-plan-change transitionStatus("applied") failed — caller state already committed; manual replay needed',
    );
    return;
  }

  // Emit `plan_change_applied` on the F2 emitter. Same Result-typed
  // pattern as accept-tier-upgrade.ts — log the typed error but DO NOT
  // roll back; the F2 row is already in `applied` terminal state.
  // Operator can backfill the audit row from the structured log.
  try {
    const auditResult = await deps.f2AuditEmitter.record(
      {
        tenant: deps.tenant,
        // 070 Item D — actor is parameterised. ONLINE = the
        // `'system:f8-on-paid-webhook'` sentinel; OFFLINE = the admin's
        // user id (admin-initiated settlement).
        actorUserId: actor.actorUserId,
        requestId: actor.requestId,
        sourceIp: null,
      },
      {
        event_type: 'plan_change_applied',
        payload: {
          member_id: memberId,
          scheduled_change_id: pending.scheduledChangeId,
          effective_at_cycle_id: cycleId,
          from_plan_id: pending.fromPlanId,
          to_plan_id: pending.toPlanId,
          applied_at_invoice_id: evt.invoiceId as unknown as string,
        },
      },
    );
    if (!auditResult.ok) {
      logger.error(
        {
          errorId: 'F2.PLAN_CHANGE.APPLIED_AUDIT_EMIT_FAILED',
          // Stable `event` discriminator preserved across the 070 helper
          // extraction (the f8-onPaid-f2-finalise unit test asserts it).
          event: 'f8_onPaid.f2_audit_emit_failed',
          audit_event: 'plan_change_applied',
          err: auditResult.error,
          tenantId: evt.tenantId,
          memberId,
          cycleId,
          scheduledChangeId: transitioned.scheduledChangeId,
          invoiceId: evt.invoiceId,
        },
        '[on-paid] F2 plan_change_applied audit emit failed — F2+caller state committed; operator backfill needed',
      );
    }
  } catch (auditErr) {
    // Defence-in-depth — F2 emitter should not throw (wraps in
    // try/catch + returns Result.err), but if it does, log critically
    // so the audit gap can be reconstructed from the structured log.
    logger.error(
      {
        // Stable `event` discriminator preserved across the 070 helper
        // extraction (the f8-onPaid-f2-finalise unit test asserts it).
        event: 'f8_onPaid.f2_audit_emit_threw',
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        tenantId: evt.tenantId,
        memberId,
        cycleId,
        scheduledChangeId: transitioned.scheduledChangeId,
        invoiceId: evt.invoiceId,
        errorId: 'F2.PLAN_CHANGE.APPLIED_AUDIT_EMIT_THREW',
      },
      '[on-paid] F2 plan_change_applied audit emit threw — manual replay needed',
    );
  }
}
