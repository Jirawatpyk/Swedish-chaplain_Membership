/**
 * F8 → F5 cross-module bridge port for payment-attempt visibility
 * (T115a Phase 5 wave K24 — `lapseCyclesOnGraceExpiry` decision-branch
 * support).
 *
 * The `awaiting_payment` → `lapsed` transition needs to discriminate
 * between two closed_reason variants per spec FR-004 + AS3:
 *   - `'grace_expired'` — `now > expires_at + grace_period_days`
 *     and the member never attempted payment (or all attempts remained
 *     `pending` / `processing`)
 *   - `'payment_failed'` — at least one F5 payment attempt failed
 *     terminally before the grace window ended
 *
 * F5 owns the `payments` table (status enum: pending | processing |
 * succeeded | failed | canceled | refunded — `failed` is the terminal
 * permanent-failure state per `src/modules/payments/domain/payment.ts`).
 * This port lets F8 query "did any payment attempt against this invoice
 * end in `failed`?" without F8 reaching into F5's schema directly
 * (Constitution Principle III — Application port + module barrel
 * boundary respected).
 *
 * Read-only port. No mutating surface. Mirrors `f5-refund-bridge.ts`
 * pattern but for queries instead of commands.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

import type { TenantId } from '@/modules/members';
import type { InvoiceId } from '@/modules/invoicing';

export interface CountFailedPaymentAttemptsInput {
  readonly tenantId: TenantId;
  readonly invoiceId: InvoiceId;
}

export interface F5PaymentAttemptsBridge {
  /**
   * Count F5 `payments` rows with `status='failed'` for the given
   * invoice. Returns 0 when the invoice has no failed attempts (or
   * no payment row at all — common when the member never clicked
   * "Pay" before the grace window expired).
   *
   * Used by `lapseCyclesOnGraceExpiry` to decide between
   * `closed_reason='grace_expired'` (count === 0) and
   * `closed_reason='payment_failed'` (count >= 1).
   */
  countFailedAttemptsForInvoice(
    input: CountFailedPaymentAttemptsInput,
  ): Promise<number>;
}
