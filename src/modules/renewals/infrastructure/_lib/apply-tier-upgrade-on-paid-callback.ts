/**
 * F8 Phase 7 / Round 6 S-003 — extracted apply-pending-tier-upgrade
 * callback factory for `f8OnPaidCallbacks`.
 *
 * The pre-Round-6 form inlined this 125-line closure as the second
 * entry of the `f8OnPaidCallbacks` array in `renewals-deps.ts`,
 * making the composition root unwieldy at ~280 lines and obscuring
 * the boundary between cycle-complete (callback[0]) and tier-upgrade
 * apply (callback[1]) logic. This helper isolates the apply path so
 * the unit test (`f8-on-paid-callbacks.test.ts`) and the callsite
 * (`renewals-deps.ts` callback[1]) reference the same factory.
 *
 * Behaviour is preserved verbatim — the closure body is moved
 * unchanged, only the deps capture is now an explicit factory
 * parameter rather than a closed-over variable.
 *
 * Pure Infrastructure — only `@/lib/db`, `@/lib/logger`,
 * `@/lib/metrics`, dynamic imports for circular-dep avoidance, and
 * F4 / F8 brand types.
 */
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { TenantTx } from '@/lib/db';
import type { F4InvoicePaidEvent, InvoiceId } from '@/modules/invoicing';
import type { MemberId as MemberIdBrand } from '@/modules/members';
import type { RenewalsDeps } from '../renewals-deps';

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

    const apply = async (tx: TenantTx, isFallback: boolean) => {
      // Resolve the cycle linked to this invoice. Non-renewal
      // invoices return null and the callback is a no-op.
      const cycle = await deps.cyclesRepo.findByInvoiceIdInTx(
        tx,
        evt.tenantId,
        evt.invoiceId,
      );
      if (!cycle) return;
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
  };
}
