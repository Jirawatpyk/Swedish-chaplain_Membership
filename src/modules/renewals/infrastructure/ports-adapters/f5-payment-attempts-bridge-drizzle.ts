/**
 * F8 Phase 5 wave K24 · T115a — Drizzle adapter for the F5 →
 * `F5PaymentAttemptsBridge` port.
 *
 * Reads F5's `payments` table directly (read-only) — counts rows with
 * `status='failed'` for the given (tenant, invoice) pair. F5's domain
 * models `'failed'` as a terminal status (`PAYMENT_STATUSES` includes
 * it; `TERMINAL_PAYMENT_STATUSES` confirms — see
 * `src/modules/payments/domain/payment.ts`), so any row with that
 * status is a permanent failure for the purposes of the
 * `payment_failed` decision branch in `lapseCyclesOnGraceExpiry`.
 *
 * Why a direct schema read (not a F5 use-case call): F5 doesn't expose
 * a "count failed attempts for invoice" use-case in its barrel today —
 * the closest is `loadInvoicePaymentActivity` which returns a richer
 * Domain projection than F8 needs. A direct read keeps the F8 cron
 * cheap (single SQL count) and avoids forcing F5 to maintain a
 * convenience use-case for one cross-module reader. If F5 ships an
 * equivalent use-case in a future wave, this adapter can rewrite to
 * compose it with no port-shape change.
 *
 * Tenant scope: RLS on `payments` enforces `tenant_id` isolation per
 * `runInTenant(ctx, …)`. Cross-tenant probes return 0 rows — the
 * lapse decision then defaults to `grace_expired`, which is the
 * conservative choice.
 */
import { and, eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { payments } from '@/modules/payments/infrastructure/schema';
import type {
  CountFailedPaymentAttemptsInput,
  F5PaymentAttemptsBridge,
} from '../../application/ports/f5-payment-attempts-bridge';

export function makeF5PaymentAttemptsBridgeDrizzle(
  ctx: TenantContext,
): F5PaymentAttemptsBridge {
  return {
    async countFailedAttemptsForInvoice(
      input: CountFailedPaymentAttemptsInput,
    ): Promise<number> {
      return runInTenant(ctx, async (tx) => {
        const rows = await tx
          .select({ n: sql<number>`COUNT(*)::int` })
          .from(payments)
          .where(
            and(
              eq(payments.invoiceId, input.invoiceId),
              eq(payments.status, 'failed'),
            ),
          );
        return rows[0]?.n ?? 0;
      });
    },
  };
}
