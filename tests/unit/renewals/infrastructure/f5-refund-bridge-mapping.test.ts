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
          creditNote: {
            kind: 'issued',
            id: 'cn-9',
            number: 'CN/2026/00009',
          },
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

  // Track B — the F8 counterpart of the case above. The money moved and there
  // is simply no §86/10 to reference, so the outcome MUST still be `refunded`
  // with a null credit-note id. Mapping this to anything else is the F-E defect:
  // F8's escalation gate would read "no credit note" as "no refund happened"
  // and skip the finance review on exactly the population that owes a manual
  // output-VAT adjustment.
  it('kind:succeeded with a WAIVED credit note → still refunded, creditNoteId null', async () => {
    issueRefundMock.mockResolvedValue(
      ok({
        kind: 'succeeded',
        refund: {
          id: 'rfnd-10',
          creditNote: { kind: 'waived', reason: 'section_105_receipt' },
        },
      }),
    );
    const result = await f5RefundBridge.issueRefundForInvoice(INPUT);
    expect(result.status).toBe('refunded');
    if (result.status === 'refunded') {
      expect(result.refundId).toBe('rfnd-10');
      expect(result.creditNoteId).toBeNull();
      expect(result.creditNoteNumber).toBeNull();
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

describe('f5RefundBridge getRefundOutcomeForInvoice mapping (F8-RP follow-up)', () => {
  const SETTLE_INPUT = {
    tenantId: asTenantId('tenant-a'),
    invoiceId: asInvoiceId('00000000-0000-0000-0000-0000000bbbb1'),
    refundId: 'rfnd-target',
  };
  const refundRow = (over: Record<string, unknown>) => ({
    refundId: 'rfnd-target',
    paymentId: 'pay-1',
    invoiceId: SETTLE_INPUT.invoiceId,
    status: 'pending',
    amountSatang: 10_000n,
    reason: 'x',
    initiatedAt: new Date(),
    completedAt: null,
    initiatorUserId: 'admin-1',
    processorRefundId: 're_x',
    failureReasonCode: null,
    creditNoteId: null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('settled succeeded → { succeeded, creditNoteId } (matched by refund id)', async () => {
    loadActivityMock.mockResolvedValue(
      ok({
        payments: [],
        refunds: [
          refundRow({ refundId: 'rfnd-other', status: 'failed' }),
          refundRow({ status: 'succeeded', creditNoteId: 'cn-settled' }),
        ],
      }),
    );
    const r = await f5RefundBridge.getRefundOutcomeForInvoice(SETTLE_INPUT);
    expect(r.status).toBe('succeeded');
    if (r.status === 'succeeded') expect(r.creditNoteId).toBe('cn-settled');
  });

  it('settled failed → { failed, failureReasonCode }', async () => {
    loadActivityMock.mockResolvedValue(
      ok({
        payments: [],
        refunds: [
          refundRow({ status: 'failed', failureReasonCode: 'stripe_refund_failed' }),
        ],
      }),
    );
    const r = await f5RefundBridge.getRefundOutcomeForInvoice(SETTLE_INPUT);
    expect(r.status).toBe('failed');
    if (r.status === 'failed') {
      expect(r.failureReasonCode).toBe('stripe_refund_failed');
    }
  });

  it('still pending → { pending }', async () => {
    loadActivityMock.mockResolvedValue(
      ok({ payments: [], refunds: [refundRow({ status: 'pending' })] }),
    );
    const r = await f5RefundBridge.getRefundOutcomeForInvoice(SETTLE_INPUT);
    expect(r.status).toBe('pending');
  });

  it('refund id absent from activity → { not_found }', async () => {
    loadActivityMock.mockResolvedValue(
      ok({
        payments: [],
        refunds: [refundRow({ refundId: 'rfnd-different', status: 'succeeded' })],
      }),
    );
    const r = await f5RefundBridge.getRefundOutcomeForInvoice(SETTLE_INPUT);
    expect(r.status).toBe('not_found');
  });

  it('activity load error → { lookup_failed, detail }', async () => {
    loadActivityMock.mockResolvedValue(
      err({ kind: 'repo_unavailable', cause: new Error('boom') }),
    );
    const r = await f5RefundBridge.getRefundOutcomeForInvoice(SETTLE_INPUT);
    expect(r.status).toBe('lookup_failed');
    if (r.status === 'lookup_failed') expect(r.detail).toBe('repo_unavailable');
  });
});

describe('f5RefundBridge findPendingRefundForInvoice mapping (F8-RP-2 Finding 3)', () => {
  const FIND_INPUT = {
    tenantId: asTenantId('tenant-a'),
    invoiceId: asInvoiceId('00000000-0000-0000-0000-0000000bbbb1'),
  };
  const refundRow = (over: Record<string, unknown>) => ({
    refundId: 'rfnd-x',
    paymentId: 'pay-1',
    invoiceId: FIND_INPUT.invoiceId,
    status: 'pending',
    amountSatang: 10_000n,
    reason: 'x',
    initiatedAt: new Date(),
    completedAt: null,
    initiatorUserId: 'admin-1',
    processorRefundId: 're_x',
    failureReasonCode: null,
    creditNoteId: null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('one pending refund present → { found, refundId, processorRefundId }', async () => {
    loadActivityMock.mockResolvedValue(
      ok({
        payments: [],
        refunds: [
          refundRow({ refundId: 'rfnd-old', status: 'failed' }),
          refundRow({
            refundId: 'rfnd-inflight',
            status: 'pending',
            processorRefundId: 're_inflight',
          }),
        ],
      }),
    );
    const r = await f5RefundBridge.findPendingRefundForInvoice(FIND_INPUT);
    expect(r.status).toBe('found');
    if (r.status === 'found') {
      expect(r.refundId).toBe('rfnd-inflight');
      expect(r.processorRefundId).toBe('re_inflight');
    }
  });

  it('no pending refund (all settled) → { none }', async () => {
    loadActivityMock.mockResolvedValue(
      ok({
        payments: [],
        refunds: [refundRow({ refundId: 'rfnd-done', status: 'succeeded' })],
      }),
    );
    const r = await f5RefundBridge.findPendingRefundForInvoice(FIND_INPUT);
    expect(r.status).toBe('none');
  });

  it('empty activity → { none }', async () => {
    loadActivityMock.mockResolvedValue(ok({ payments: [], refunds: [] }));
    const r = await f5RefundBridge.findPendingRefundForInvoice(FIND_INPUT);
    expect(r.status).toBe('none');
  });

  it('activity load error → { lookup_failed, detail }', async () => {
    loadActivityMock.mockResolvedValue(
      err({ kind: 'repo_unavailable', cause: new Error('boom') }),
    );
    const r = await f5RefundBridge.findPendingRefundForInvoice(FIND_INPUT);
    expect(r.status).toBe('lookup_failed');
    if (r.status === 'lookup_failed') expect(r.detail).toBe('repo_unavailable');
  });
});
