/**
 * F8 Phase 5 Wave A.5 · T137 — `F5RefundBridge` test-only stub.
 *
 * The production drizzle adapter ships in `f5-refund-bridge-drizzle.ts`
 * (composes F5 `loadInvoicePaymentActivity` + `computeRemainingRefundable`
 * + `issueRefund`, which cascades F4 credit-note creation) and is wired
 * into `renewals-deps.ts`. This stub stays as a defence-in-depth
 * fallback that loud-throws rather than no-op'ing.
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
