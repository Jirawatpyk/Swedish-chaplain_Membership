/**
 * F8 Phase 5 Wave A.5 · T137 — `F5RefundBridge` stub adapter.
 *
 * Production adapter (`f5-refund-bridge.ts`) composes F5's
 * `loadInvoicePaymentActivity` + `issueRefund` use-cases — that wiring
 * lands when the admin-reject route handler (T142) + reconcile-cron
 * route (T139/T140) are built. Until then T137 + T138 use this stub
 * which throws on every call so production code paths cannot
 * accidentally rely on it.
 *
 * Test composition replaces this stub with an in-memory mock per spec
 * (see `tests/unit/renewals/application/use-cases/admin-reject-reactivation.test.ts`).
 *
 * Wiring this to a no-op (e.g., always-return `'no_payment_found'`)
 * was deliberately rejected: a silent no-op would let a misconfigured
 * production path issue an audit row claiming "no refund needed" when
 * F5 was actually unreachable. Loud-throw forces the deployment to
 * surface the gap before flipping `FEATURE_F8_RENEWALS=true`.
 */
import type {
  F5RefundBridge,
  IssueRefundForInvoiceInput,
  IssueRefundForInvoiceResult,
} from '../../application/ports/f5-refund-bridge';

export const f5RefundBridgeStub: F5RefundBridge = {
  async issueRefundForInvoice(
    _input: IssueRefundForInvoiceInput,
  ): Promise<IssueRefundForInvoiceResult> {
    throw new Error(
      'f5RefundBridgeStub.issueRefundForInvoice was called — wire the real ' +
        'adapter via `makeRenewalsDeps` before invoking T137 / T138 in production.',
    );
  },
};
