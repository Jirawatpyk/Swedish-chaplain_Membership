/**
 * F5 Phase 5 (T097) — loadInvoicePaymentActivity use-case.
 *
 * Read-only projection consumed by the admin invoice detail timeline
 * panel (`payment-timeline.tsx` server component). Returns every
 * payment + refund row tied to the invoice so the UI can synthesize
 * the chronological event stream:
 *
 *   payment_initiated → payment_succeeded|failed|canceled
 *   → invoice_paid (when terminal=succeeded; emitted by F4 markPaid)
 *   → refund_initiated → refund_succeeded|failed (per refund)
 *
 * No mutation, no audit emit, no Stripe call. Tenant isolation is
 * enforced by `runInTenant` + RLS+FORCE policies inside the repo.
 *
 * Verify-fix C2 (2026-04-26): the previous `error: never` typing
 * silently let DB / RLS errors propagate as thrown exceptions, which
 * surfaced as 500s without context in the admin detail page. This
 * use-case now wraps the repo call in try/catch and returns a typed
 * `Result.err({kind: 'repo_unavailable', cause})` so the server
 * component can render a graceful empty / error state instead of
 * crashing the whole route.
 */
import { ok, err, type Result } from '@/lib/result';
import { asSatang, type Satang } from '@/lib/money';
import type {
  PaymentsRepo,
  RefundActivityDto,
} from '../ports/payments-repo';
import type { Payment } from '../../domain/payment';

export interface LoadInvoicePaymentActivityInput {
  readonly tenantId: string;
  readonly invoiceId: string;
}

export interface LoadInvoicePaymentActivityOutput {
  readonly payments: readonly Payment[];
  readonly refunds: readonly RefundActivityDto[];
}

export type LoadInvoicePaymentActivityError = {
  readonly kind: 'repo_unavailable';
  readonly cause: unknown;
};

export interface LoadInvoicePaymentActivityDeps {
  readonly paymentsRepo: PaymentsRepo;
}

export async function loadInvoicePaymentActivity(
  deps: LoadInvoicePaymentActivityDeps,
  input: LoadInvoicePaymentActivityInput,
): Promise<
  Result<LoadInvoicePaymentActivityOutput, LoadInvoicePaymentActivityError>
> {
  try {
    const activity = await deps.paymentsRepo.listInvoiceActivity(
      input.tenantId,
      input.invoiceId,
    );
    return ok(activity);
  } catch (cause) {
    return err({ kind: 'repo_unavailable', cause });
  }
}

/**
 * Pure projection over `LoadInvoicePaymentActivityOutput` — surfaces
 * the latest succeeded payment (one-succeeded-per-invoice invariant
 * means this is unique in practice; `completed_at DESC` ordering is
 * deterministic if a future flow ever permits more) and the
 * remaining refundable balance, computed as
 *
 *     remaining = succeededPayment.amountSatang
 *               − Σ(refunds where status='succeeded'
 *                   AND payment_id === succeededPayment.id)
 *
 * Returns `null` when no succeeded payment exists OR when the
 * remaining is ≤ 0 (i.e. the payment is fully refunded). Callers
 * should treat null as "no refund possible" and hide the refund UI.
 *
 * Used by the admin invoice detail page (`page.tsx`) and the cmdk
 * palette refundable-invoice fetch (`/api/plans/search`) — extracted
 * here so both surfaces share the exact same arithmetic.
 */
export function computeRemainingRefundable(
  activity: LoadInvoicePaymentActivityOutput,
): { readonly paymentId: string; readonly remainingSatang: Satang } | null {
  const succeededPayment = [...activity.payments]
    .filter(
      (p) => p.status === 'succeeded' || p.status === 'partially_refunded',
    )
    .sort((a, b) => {
      const aT = a.completedAt?.getTime() ?? 0;
      const bT = b.completedAt?.getTime() ?? 0;
      return bT - aT;
    })[0];
  if (!succeededPayment) return null;
  const sumSucceededRefunds = activity.refunds
    .filter(
      (r) => r.status === 'succeeded' && r.paymentId === succeededPayment.id,
    )
    .reduce((acc, r) => acc + r.amountSatang, 0n);
  const remaining = succeededPayment.amountSatang - sumSucceededRefunds;
  if (remaining <= 0n) return null;
  // F5R3v2 H-5 (2026-05-16) — brand the result so consumers (F8
  // bridge, admin page, cmdk) receive a typed Satang. asSatang
  // validates non-negative; the gate above guarantees > 0.
  return { paymentId: succeededPayment.id, remainingSatang: asSatang(remaining) };
}
