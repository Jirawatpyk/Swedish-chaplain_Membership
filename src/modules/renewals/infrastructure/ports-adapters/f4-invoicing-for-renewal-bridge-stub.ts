/**
 * F8 Phase 5 Wave B · T122 — `F4InvoicingForRenewalBridge` stub.
 *
 * Production adapter composes F4's `createInvoiceDraft` +
 * `issueInvoice` use-cases — wiring lands when the public renewal
 * confirm POST route (T130) is built. Until then T122 use this stub
 * which throws on every call so production paths cannot rely on it.
 *
 * Test composition replaces this with an in-memory mock per spec.
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
