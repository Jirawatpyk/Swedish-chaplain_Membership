/**
 * `pendingPaymentCanceller` is an OPTIONAL deps member on both `voidInvoice`
 * (#446 review M-a, review L-1) and `recordPayment` (#452 review M1), so every
 * unit test of either use-case stays green if a refactor of the composition
 * root silently stops wiring it — and a voided or manually paid invoice's
 * live PaymentIntent would again stay capturable. Pin the wiring on every
 * production path, and pin that recordPayment does NOT get it when it runs
 * inside a caller-owned transaction (webhook / F8 offline), where "after
 * recordPayment returns" is not after commit.
 */
import { describe, expect, it } from 'vitest';
import {
  makeIssueMembershipBillDeps,
  makeRecordPaymentDeps,
  makeVoidInvoiceDeps,
} from '@/modules/invoicing/application/invoicing-deps';

describe('composition wires the pending-payment canceller', () => {
  it('admin void (makeVoidInvoiceDeps)', () => {
    const deps = makeVoidInvoiceDeps('tenant-wiring');
    expect(typeof deps.pendingPaymentCanceller?.cancelPendingPayments).toBe('function');
  });

  it('void-on-reissue (makeIssueMembershipBillDeps → voidDeps)', () => {
    const deps = makeIssueMembershipBillDeps('tenant-wiring');
    expect(typeof deps.voidDeps.pendingPaymentCanceller?.cancelPendingPayments).toBe(
      'function',
    );
  });

  it('admin manual record-payment (makeRecordPaymentDeps, owns its tx)', () => {
    const deps = makeRecordPaymentDeps('tenant-wiring');
    expect(typeof deps.pendingPaymentCanceller?.cancelPendingPayments).toBe('function');
  });

  it('record-payment inside a caller-owned tx (webhook / F8 offline) → NOT wired', () => {
    const deps = makeRecordPaymentDeps('tenant-wiring', { callerOwnedTx: true });
    expect(deps.pendingPaymentCanceller).toBeUndefined();
  });
});
