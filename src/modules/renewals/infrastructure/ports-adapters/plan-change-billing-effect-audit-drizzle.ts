/**
 * Plan-change -> billing remediation (Package A) — Drizzle adapter for
 * `PlanChangeBillingEffectAuditPort`.
 *
 * Persists the `member_plan_change_billing_effect` event to F1's `audit_log`
 * inside the caller's tx (atomic with the state mutation, Principle VIII).
 * The pgEnum value ships in migration 0270 — apply it before this adapter is
 * exercised (F4 R8 gotcha: unit mocks hide pgEnum gaps).
 *
 * `retention_years` is left NULL so the DB trigger applies the 5-year default
 * (this is NOT a tax-document event). `actor_user_id` is a plain text column
 * (no FK), so the `system:renewals` sentinel for system-driven emits is safe
 * — same convention as the F8 emitter's `system:<role>`.
 *
 * Pure Infrastructure — writes via the passed tx + the F1 schema (no
 * Application-layer imports; Constitution Principle III).
 */
import { auditLog, type AuditLogInsert } from '@/modules/auth/infrastructure/db/schema';
import type { db } from '@/lib/db';
import type {
  PlanChangeBillingEffectAuditPort,
} from '../../application/ports/plan-change-billing-effect-audit-port';

const EVENT_TYPE = 'member_plan_change_billing_effect';

export const planChangeBillingEffectAuditDrizzle: PlanChangeBillingEffectAuditPort =
  {
    async emitInTx(tx, ctx, input) {
      const values: AuditLogInsert = {
        eventType: EVENT_TYPE as AuditLogInsert['eventType'],
        actorUserId: ctx.actorUserId ?? 'system:renewals',
        summary:
          `Plan-change billing effect: ${input.effect} ` +
          `(member=${input.memberId}, ${input.oldPlanId} -> ${input.newPlanId})`.slice(
            0,
            500,
          ),
        requestId: ctx.correlationId,
        tenantId: ctx.tenantId,
        payload: {
          member_id: input.memberId,
          old_plan_id: input.oldPlanId,
          new_plan_id: input.newPlanId,
          cycle_id: input.cycleId,
          effect: input.effect,
          old_price_thb: input.oldPriceThb,
          new_price_thb: input.newPriceThb,
          effective_from: input.effectiveFrom,
          blocking_invoice_id: input.blockingInvoiceId,
          blocking_source: input.blockingSource,
        },
        // timestamp + id default at the DB layer; retention_years NULL ->
        // trigger applies the 5-year default.
      };
      const txDb = tx as unknown as typeof db;
      await txDb.insert(auditLog).values(values);
    },
  };
