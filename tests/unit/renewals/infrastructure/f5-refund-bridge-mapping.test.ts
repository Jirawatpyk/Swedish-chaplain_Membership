/**
 * F8-RP — F8 → F5 refund-bridge OUTCOME MAPPING unit test.
 *
 * Pins the runtime mapping the production `f5RefundBridge` adapter
 * performs over F5 `issueRefund`'s discriminated result. The F5 barrel
 * is mocked so this test asserts ONLY the adapter's outcome translation
 * (Clean Architecture: F8's view of F5 in isolation), not F5 internals.
 *
 * Contract under test (F8-RP):
 *   - `issueRefund` → ok({ kind:'succeeded', … })       ⇒ `refunded`
 *   - `issueRefund` → ok({ kind:'pending', … })          ⇒ `refund_pending` (+ ids)
 *   - `issueRefund` → err({ code:'refund_in_progress' })   ⇒ `refund_pending` (no ids)
 *   - `issueRefund` → err({ code:'processor_unavailable' }) ⇒ `refund_failed` (regression)
 *   - `computeRemainingRefundable` → null                 ⇒ `no_payment_found`
 *
 * Money-safety: the `refund_pending` branch NEVER books a credit note —
 * the F5 refund row stays `pending` and settles via the A.11 webhook /
 * A.14 sweep. A genuine Stripe failure stays `refund_failed`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';
import { asTenantId } from '@/modules/members';
import { asInvoiceId } from '@/modules/invoicing';

// `@/lib/db` is imported transitively by the module/brand barrels; stub it
// so the unit test never opens a Neon pool (mirrors the reconcile/admin-
// reject unit-test convention).
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

const { loadActivityMock, computeRemainingMock, issueRefundMock } = vi.hoisted(
  () => ({
    loadActivityMock: vi.fn(),
    computeRemainingMock: vi.fn(),
    issueRefundMock: vi.fn(),
  }),
);

vi.mock('@/modules/payments', () => ({
  loadInvoicePaymentActivity: loadActivityMock,
  computeRemainingRefundable: computeRemainingMock,
  issueRefund: issueRefundMock,
  makeIssueRefundDeps: () => ({}),
  makeLoadInvoicePaymentActivityDeps: () => ({}),
}));

import { f5RefundBridge } from '@/modules/renewals/infrastructure/ports-adapters/f5-refund-bridge-drizzle';

const INPUT = {
  tenantId: asTenantId('tenant-a'),
  invoiceId: asInvoiceId('00000000-0000-0000-0000-0000000bbbb1'),
  reason: 'admin rejected reactivation',
  actorUserId: 'admin-1',
  correlationId: 'corr-1',
  requestId: null,
};

describe('f5RefundBridge outcome mapping (F8-RP)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: a succeeded payment with THB 100 remaining refundable.
    loadActivityMock.mockResolvedValue(ok({ payments: [], refunds: [] }));
    computeRemainingMock.mockReturnValue({
      paymentId: 'pay-1',
      remainingSatang: 10_000,
    });
  });

  it('kind:pending → refund_pending carrying refundId + processorRefundId (NOT refund_failed)', async () => {
    issueRefundMock.mockResolvedValue(
      ok({
        kind: 'pending',
        refund: { id: 'rfnd-1', status: 'pending', processorRefundId: 're_abc' },
      }),
    );
    const result = await f5RefundBridge.issueRefundForInvoice(INPUT);
    expect(result.status).toBe('refund_pending');
    if (result.status === 'refund_pending') {
      expect(result.refundId).toBe('rfnd-1');
      expect(result.processorRefundId).toBe('re_abc');
    }
  });

  it('refund_in_progress → refund_pending (no ids; a prior refund is already settling)', async () => {
    issueRefundMock.mockResolvedValue(err({ code: 'refund_in_progress' }));
    const result = await f5RefundBridge.issueRefundForInvoice(INPUT);
    expect(result.status).toBe('refund_pending');
    if (result.status === 'refund_pending') {
      expect(result.refundId).toBeUndefined();
      expect(result.processorRefundId).toBeUndefined();
    }
  });

  it('kind:succeeded → refunded (credit note booked synchronously)', async () => {
    issueRefundMock.mockResolvedValue(
      ok({
        kind: 'succeeded',
        refund: {
          id: 'rfnd-9',
          creditNoteId: 'cn-9',
          creditNoteNumber: 'CN/2026/00009',
        },
      }),
    );
    const result = await f5RefundBridge.issueRefundForInvoice(INPUT);
    expect(result.status).toBe('refunded');
    if (result.status === 'refunded') {
      expect(result.refundId).toBe('rfnd-9');
      expect(result.creditNoteId).toBe('cn-9');
    }
  });

  it('REGRESSION: genuine processor_unavailable → refund_failed (unchanged)', async () => {
    issueRefundMock.mockResolvedValue(
      err({ code: 'processor_unavailable', kind: 'permanent', reason: 'failed' }),
    );
    const result = await f5RefundBridge.issueRefundForInvoice(INPUT);
    expect(result.status).toBe('refund_failed');
    if (result.status === 'refund_failed') {
      expect(result.errorCode).toBe('processor_unavailable');
    }
  });

  it('no succeeded payment / fully refunded → no_payment_found (refund never attempted)', async () => {
    computeRemainingMock.mockReturnValue(null);
    const result = await f5RefundBridge.issueRefundForInvoice(INPUT);
    expect(result.status).toBe('no_payment_found');
    expect(issueRefundMock).not.toHaveBeenCalled();
  });
});
