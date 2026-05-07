/**
 * F8 Phase 5 Wave B · T122 — `F4InvoicingForRenewalBridge` test-only stub.
 *
 * The production drizzle adapter ships in
 * `f4-invoicing-for-renewal-bridge-drizzle.ts` and is wired into
 * `renewals-deps.ts`. This stub remains in the tree as a defence-in-
 * depth fallback: if test composition forgets to override the
 * production adapter it loud-throws rather than no-op'ing — explicit
 * rejection of a silent-failure trap. Production code paths CANNOT
 * accidentally rely on it because `makeRenewalsDeps` selects the
 * drizzle adapter directly.
 */
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalInput,
  IssueInvoiceForRenewalResult,
} from '../../application/ports/f4-invoicing-bridge';

export const f4InvoicingForRenewalBridgeStub: F4InvoicingForRenewalBridge = {
  async issueInvoiceForRenewal(
    _input: IssueInvoiceForRenewalInput,
  ): Promise<IssueInvoiceForRenewalResult> {
    throw new Error(
      'f4InvoicingForRenewalBridgeStub.issueInvoiceForRenewal was called — wire ' +
        'the real adapter via `makeRenewalsDeps` before invoking T122 in production.',
    );
  },
};
