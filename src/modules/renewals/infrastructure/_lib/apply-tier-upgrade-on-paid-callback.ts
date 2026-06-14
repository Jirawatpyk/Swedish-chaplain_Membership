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
// 070 Item D — the F2 scheduled-plan-change finalisation logic was
// EXTRACTED to a shared Application use-case so both the online F4
// invoice-paid callback (here) and the OFFLINE admin mark-paid path
// (`mark-paid-offline.ts`) finalise the F2 row through a single source of
// truth (Clean Architecture: Application use-case calls another Application
// use-case; the offline path could not value-import this Infrastructure
// helper). This thin wrapper delegates to it with the ONLINE webhook actor,
// preserving the `_internal` test seam.
import {
  finaliseF2PlanChangeOnPaid,
  defaultOnlineF2Actor,
} from '../../application/use-cases/finalise-f2-plan-change-on-paid';
import type { RenewalsDeps } from '../renewals-deps';

// F2 scheduled-plan-change finalisation + audit emit. Runs POST-tx;
// failures are logged + non-rollback (mirrors the post-tx F2 emit
// pattern in `accept-tier-upgrade.ts` where F4 has already committed
// by the time we reach this code). Delegates to the shared Application
// helper with the ONLINE `'system:f8-on-paid-webhook'` actor.
async function finaliseF2ScheduledPlanChangeForCycle(
  deps: RenewalsDeps,
  evt: F4InvoicePaidEvent,
  cycleId: string,
): Promise<void> {
  await finaliseF2PlanChangeOnPaid(
    deps,
    evt,
    cycleId,
    defaultOnlineF2Actor(evt),
  );
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
        await applyPendingTierUpgradeInTx(deps, tx, {
          tenantId: evt.tenantId,
          cycleId: cycle.cycleId,
          invoiceId: evt.invoiceId as unknown as InvoiceId,
          correlationId: `f8-onPaid:${evt.invoiceId}`,
          requestId: null,
        });
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
    // 065 Fix A precision — invoke the F2 finaliser whenever a renewal
    // cycle was resolved; the finaliser itself now gates per-pending-row on
    // the F2 row's OWN linked suggestion status (parsed from `reason`),
    // closing BOTH the original S6 re-bill hole AND the retry-heal /
    // re-accept precision holes:
    //
    //   - S6 re-bill: when a manual override SUPERSEDED the suggestion but
    //     missed its orphan F2 pending row, the finaliser resolves that
    //     row's `superseded` suggestion → skips (no re-bill).
    //   - S1 retry-heal: a webhook re-delivery whose suggestion is already
    //     `applied` (NOT superseded) → finalises + heals the stranded row.
    //   - S0 standalone schedule: no suggestion link in `reason` → the
    //     finaliser proceeds (and no-ops cleanly when no pending row).
    //   - Re-accept precision: TWO suggestions target one cycle (a
    //     superseded suggestion1 + a fresh accepted suggestion2's pending
    //     row). The prior cycle-wide `hasSupersededSuggestionForCycle`
    //     matched suggestion1 → wrongly skipped, stranding suggestion2's
    //     valid upgrade. The per-row gate resolves suggestion2 (NOT
    //     superseded) → finalises.
    //
    // The `f2FinaliseBeforeF4Commit` SRE counter moved INTO the finaliser
    // (it now bumps only when the finaliser actually proceeds to the
    // pending→applied transition, after the per-row skip decision).
    if (resolvedCycleId !== null) {
      await finaliseF2ScheduledPlanChangeForCycle(
        deps,
        evt,
        resolvedCycleId,
      );
    }
  };
}
