/**
 * F4 onPaid callback factory — applies pending F8 tier-upgrade
 * suggestions then finalises F2 scheduled-plan-change rows post-tx.
 *
 * Returns a closure that the F8 composition root registers as
 * `f8OnPaidCallbacks[1]`. Two-phase behaviour per invoice:
 *
 *   1. In-tx (F4 withTx): resolve the renewal cycle for the invoice;
 *      if found, run `applyPendingTierUpgradeInTx` to transition any
 *      `accepted_pending_apply` suggestions to `applied` + emit F8
 *      audit. F4 commit fails ⇒ entire in-tx state rolls back.
 *
 *   2. Post-tx (separate `runInTenant`): `_internal.finaliseF2
 *      ScheduledPlanChangeForCycle` flips the F2
 *      `scheduled_plan_changes` row pending → applied and emits the
 *      F2 audit. Eventual-consistency window bounded by idempotency
 *      (Stripe at-least-once retry self-heals; counter
 *      `renewalsMetrics.f2FinaliseBeforeF4Commit` is the SRE signal).
 *
 * Pure Infrastructure — `@/lib/db`, `@/lib/logger`, `@/lib/metrics`,
 * dynamic imports for circular-dep avoidance, F4 / F8 brand types.
 */
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { TenantTx } from '@/lib/db';
import type { F4InvoicePaidEvent, InvoiceId } from '@/modules/invoicing';
import type { MemberId as MemberIdBrand } from '@/modules/members';
import type { RenewalsDeps } from '../renewals-deps';

// F2 scheduled-plan-change finalisation + audit emit. Runs POST-tx;
// failures are logged + non-rollback (mirrors the post-tx F2 emit
// pattern in `accept-tier-upgrade.ts` where F4 has already committed
// by the time we reach this code).
async function finaliseF2ScheduledPlanChangeForCycle(
  deps: RenewalsDeps,
  evt: F4InvoicePaidEvent,
  cycleId: string,
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
      '[f8-onPaid] F2 scheduled-plan-change findPendingForCycle failed — F4 already committed; manual replay needed',
    );
    return;
  }

  // Cycles without a pending F2 scheduled-plan-change row (the common
  // case — same-tier renewal, no plan switch scheduled) are a no-op.
  // Idempotent on re-fire: already-applied rows return null from
  // `findPendingForCycle` (terminal-state semantics, partial-unique
  // guarantee).
  if (pending === null) return;

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
      '[f8-onPaid] F2 scheduled-plan-change transitionStatus("applied") failed — F4 already committed; manual replay needed',
    );
    return;
  }

  // Emit `plan_change_applied` on the F2 emitter. Same Result-typed
  // pattern as accept-tier-upgrade.ts:358-414 — log the typed error
  // but DO NOT roll back; the F2 row is already in `applied` terminal
  // state. Operator can backfill the audit row from the structured
  // log.
  try {
    const auditResult = await deps.f2AuditEmitter.record(
      {
        tenant: deps.tenant,
        // F4 onPaid callbacks fire from webhook OR admin-offline-mark
        // paths; the actor for the F2 cascade is the F4 contract, not
        // the original admin. F2 `AuditContext.actorUserId` is a
        // required `string`, so we use the canonical system sentinel
        // (mirrors F1 audit pattern: `'system:webhook'` /
        // `'system:cron'` actors).
        actorUserId: 'system:f8-on-paid-webhook',
        requestId: `f8-onPaid:${evt.invoiceId}`,
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
      // errorId for alert-routing parity with the threw-branch
      // (F2.PLAN_CHANGE.APPLIED_AUDIT_EMIT_THREW) + the find/transition
      // errorIds above. Sentry/Grafana alert rules built against
      // `errorId: 'F2.PLAN_CHANGE.*'` now catch the persist_failed
      // path too.
      logger.error(
        {
          errorId: 'F2.PLAN_CHANGE.APPLIED_AUDIT_EMIT_FAILED',
          event: 'f8_onPaid.f2_audit_emit_failed',
          audit_event: 'plan_change_applied',
          err: auditResult.error,
          tenantId: evt.tenantId,
          memberId,
          cycleId,
          scheduledChangeId: transitioned.scheduledChangeId,
          invoiceId: evt.invoiceId,
        },
        '[f8-onPaid] F2 plan_change_applied audit emit failed — F2+F8+F4 state committed; operator backfill needed',
      );
    }
  } catch (auditErr) {
    // Defence-in-depth — F2 emitter should not throw (wraps in
    // try/catch + returns Result.err), but if it does, log critically
    // so the audit gap can be reconstructed from the structured log.
    logger.error(
      {
        event: 'f8_onPaid.f2_audit_emit_threw',
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        tenantId: evt.tenantId,
        memberId,
        cycleId,
        scheduledChangeId: transitioned.scheduledChangeId,
        invoiceId: evt.invoiceId,
        errorId: 'F2.PLAN_CHANGE.APPLIED_AUDIT_EMIT_THREW',
      },
      '[f8-onPaid] F2 plan_change_applied audit emit threw — manual replay needed',
    );
  }
}

// Re-export for unit testing of the F2 finalisation helper in
// isolation (test at
// `tests/unit/renewals/infrastructure/f8-onPaid-f2-finalise.test.ts`).
export const _internal = {
  finaliseF2ScheduledPlanChangeForCycle,
};

export function makeApplyTierUpgradeOnPaidCallback(
  deps: RenewalsDeps,
  tenantId: string,
): (evt: F4InvoicePaidEvent, txUnknown: unknown) => Promise<void> {
  return async (
    evt: F4InvoicePaidEvent,
    txUnknown: unknown,
  ): Promise<void> => {
    const { applyPendingTierUpgradeInTx } = await import(
      '../../application/use-cases/apply-pending-tier-upgrade'
    );
    const { runInTenant: runInTenantFn, isTenantTx } = await import(
      '@/lib/db'
    );

    // Capture the resolved cycle id for the post-tx F2 finalisation.
    // The original closure short-circuited on `!cycle`, so we surface
    // the captured id (or null) upward via the outer scope so the
    // post-tx Batch 2d path can decide whether to invoke the F2
    // finaliser. Idempotent + cheap: the cycle row was just touched
    // in-tx so still in the connection's read cache for any later
    // read (which the F2 finaliser does NOT need — it only consults
    // `scheduled_plan_changes`).
    let resolvedCycleId: string | null = null;
    // 065 S6 — count of F8 suggestions the apply ACTUALLY transitioned
    // to `applied` for this cycle. The post-tx F2 finaliser is gated on
    // this being > 0 (see the gate below). Decoupling the finaliser
    // from the apply result re-bills a supersede-cancelled upgrade: if a
    // manual override superseded the F8 suggestion but missed the F2
    // pending row (the orphan state), the apply no-ops (returns []) yet
    // the finaliser would flip the orphan F2 row pending → applied and
    // emit `plan_change_applied`. Both aggregates MUST agree — there is
    // no production path where the F2 row is finalised without an F8
    // suggestion having been applied (every F2 pending row is created by
    // `acceptTierUpgrade` alongside its F8 suggestion).
    let appliedSuggestionCount = 0;
    const apply = async (tx: TenantTx, isFallback: boolean) => {
      // Resolve the cycle linked to this invoice. Non-renewal
      // invoices return null and the callback is a no-op.
      const cycle = await deps.cyclesRepo.findByInvoiceIdInTx(
        tx,
        evt.tenantId,
        evt.invoiceId,
      );
      if (!cycle) return;
      resolvedCycleId = cycle.cycleId;
      try {
        const applied = await applyPendingTierUpgradeInTx(deps, tx, {
          tenantId: evt.tenantId,
          cycleId: cycle.cycleId,
          invoiceId: evt.invoiceId as unknown as InvoiceId,
          correlationId: `f8-onPaid:${evt.invoiceId}`,
          requestId: null,
        });
        appliedSuggestionCount = applied.length;
      } catch (e) {
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            tenantId: evt.tenantId,
            invoiceId: evt.invoiceId,
            cycleId: cycle.cycleId,
          },
          '[f8-onPaid] apply-pending-tier-upgrade failed — F4 tx rolling back',
        );
        // Phase 7 review-fix Round 2 SUG-6: when running in the
        // INVALID_TX fallback (F4 already committed), emit the
        // post-paid-failed audit + counter so the orphan suggestion
        // (paid invoice but tier-upgrade not applied) has a forensic
        // chain entry.
        if (isFallback) {
          renewalsMetrics.tierUpgradeApplyPostPaidFailed(evt.tenantId);
          try {
            await deps.auditEmitter.emit(
              {
                type: 'tier_upgrade_apply_post_invoice_paid_failed',
                payload: {
                  invoice_id: evt.invoiceId as unknown as InvoiceId,
                  member_id: evt.memberId as unknown as MemberIdBrand,
                  cycle_id: cycle.cycleId,
                  failure_message:
                    e instanceof Error
                      ? e.message.slice(0, 200)
                      : 'unknown',
                },
              },
              {
                tenantId: evt.tenantId,
                actorUserId: null,
                actorRole: 'webhook',
                correlationId: `f8-onPaid:${evt.invoiceId}`,
                requestId: null,
              },
            );
          } catch (auditErr) {
            // Audit emit can throw via pgEnum drift's pinoFallback.
            // Counter still bumped + log escalated to fatal.
            logger.fatal(
              {
                err:
                  auditErr instanceof Error
                    ? auditErr.message
                    : String(auditErr),
                tenantId: evt.tenantId,
                invoiceId: evt.invoiceId,
                cycleId: cycle.cycleId,
                errorId: 'F8.APPLY_TIER.POST_PAID_AUDIT_EMIT_FAILED',
              },
              '[f8-onPaid] post-paid-failed audit emit failed — counter still bumped, manual replay required',
            );
          }
        }
        throw e;
      }
    };

    if (txUnknown !== undefined && isTenantTx(txUnknown)) {
      await apply(txUnknown, false);
    } else {
      // F4 contract drift surface — when F4 invokes the callback
      // WITHOUT a TenantTx (or with a shape that fails `isTenantTx`),
      // the apply path runs in its own runInTenant. F4 has already
      // committed by then; if `apply` throws, the F8 audit chain has
      // a forensic gap. Counter + structured log so on-call alert
      // rules detect the drift.
      const { renewalsMetrics: m } = await import('@/lib/metrics');
      m.applyPendingInvalidTx.add(1, { tenant_id: tenantId });
      logger.error(
        {
          errorId: 'F8.APPLY_TIER.INVALID_TX',
          tenantId,
          invoiceId: evt.invoiceId,
          memberId: evt.memberId,
          txKeys:
            txUnknown !== null && typeof txUnknown === 'object'
              ? Object.keys(txUnknown as Record<string, unknown>).slice(0, 10)
              : null,
          txType: typeof txUnknown,
        },
        '[f8-onPaid] apply-pending received non-TenantTx — falling back to runInTenant; F4 callback contract drift suspected',
      );
      await runInTenantFn(deps.tenant, (tx) => apply(tx, true));
    }

    // F2 finaliser runs in its OWN `runInTenant` tx, which is SEPARATE
    // from F4's `withTx` even on the happy path. F4's commit happens
    // AFTER this callback returns. The consequence is a bounded
    // TEMPORAL divergence — if F4's commit subsequently fails (rare;
    // commit-stage error), F2 has already advanced one step ahead.
    // The next webhook retry (Stripe at-least-once) heals because
    // (a) F4 mark-paid is idempotent on already-paid invoices and
    // (b) F2 finaliser is idempotent on already-applied rows
    // (findPendingForCycle returns null for terminal-state).
    //
    // Operational signal: `renewalsMetrics.f2FinaliseBeforeF4Commit`
    // is incremented at this site BEFORE the finaliser runs so
    // on-call can detect the rare F4-commit-failure-after-F2-commit
    // scenario by correlating this counter against
    // `tierUpgradeApplyPostPaidFailed` (which fires on the fallback
    // INVALID_TX path) and against F4's `invoice_mark_paid_failed`
    // counter. If repeated firing surfaces in prod, the architectural
    // fix is `RecordPaymentDeps.onAfterCommitCallbacks` — tracked as
    // Round-4+ feature.
    //
    // 065 S6 — gate the F2 finaliser on the F8 apply having actually
    // transitioned a suggestion for this cycle (`appliedSuggestionCount
    // > 0`). When the apply no-ops (no `accepted_pending_apply`
    // suggestion — same-tier renewal OR the orphan state where a
    // supersede cancelled the F8 suggestion but missed the F2 pending
    // row), the F2 row MUST NOT be flipped pending → applied: doing so
    // re-bills an upgrade the supersede meant to cancel (money bug). The
    // two aggregates agree by construction — every F2 pending row is
    // created by `acceptTierUpgrade` alongside its F8 suggestion, so a
    // zero-apply cycle has no legitimate F2 finalisation to perform.
    if (resolvedCycleId !== null && appliedSuggestionCount > 0) {
      renewalsMetrics.f2FinaliseBeforeF4Commit(evt.tenantId);
      await finaliseF2ScheduledPlanChangeForCycle(
        deps,
        evt,
        resolvedCycleId,
      );
    }
  };
}
