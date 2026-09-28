/**
 * #446 review M-a (review L-1) — `pendingPaymentCanceller` is an OPTIONAL
 * `VoidInvoiceDeps` member, so every `voidInvoice` unit test stays green if a
 * refactor of the composition root silently stops wiring it — and the voided
 * invoice's live PaymentIntent would again stay capturable. Pin the wiring on
 * both production paths: the admin void route and void-on-reissue.
 */
import { describe, expect, it } from 'vitest';
import {
  makeIssueMembershipBillDeps,
  makeVoidInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';

describe('voidInvoice composition wires the pending-payment canceller', () => {
  it('admin void (makeVoidInvoiceDeps)', () => {
    const deps = makeVoidInvoiceDeps('tenant-wiring');
    expect(typeof deps.pendingPaymentCanceller?.cancelPendingPaymentsForVoidedInvoice).toBe(
      'function',
    );
  });

  it('void-on-reissue (makeIssueMembershipBillDeps → voidDeps)', () => {
    const deps = makeIssueMembershipBillDeps('tenant-wiring');
    expect(
      typeof deps.voidDeps.pendingPaymentCanceller?.cancelPendingPaymentsForVoidedInvoice,
    ).toBe('function');
  });
});
