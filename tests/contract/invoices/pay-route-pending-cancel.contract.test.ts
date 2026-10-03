/**
 * #452 financial-integrity review (M1) — contract: POST /api/invoices/[id]/pay
 * cancels the invoice's still-live PaymentIntents as its LAST post-commit
 * step.
 *
 * Pins what only the route decides (the real `cancelPendingPaymentsAfterManualPayment`
 * runs; only the canceller port, recordPayment and the renewals barrel are
 * mocked):
 *   - the cancel runs AFTER the F2 plan-change finaliser (`f8AfterCommitCallbacks`)
 *     — its Stripe round-trips must not stand between the committed payment
 *     and that finaliser;
 *   - cause `invoice_paid_manually` for a fresh payment, `invoice_already_paid`
 *     when recordPayment reports a replay; actor = the admin, requestId;
 *   - a refused payment never cancels;
 *   - a canceller that throws never changes the 200.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const recordPaymentMock = vi.fn();
const cancelMock = vi.fn();
const order: string[] = [];

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-pay-cancel-1' }));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async (..._args: unknown[]) => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// F8 ON so the route runs its post-commit F2 finaliser loop.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, features: { ...actual.env.features, f8Renewals: true } },
  };
});
vi.mock('@/modules/renewals', () => ({
  f8OnPaidCallbacks: () => [],
  f8AfterCommitCallbacks: () => [
    async () => {
      order.push('f2-finalise');
    },
  ],
}));
vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    recordPayment: (...args: unknown[]) => recordPaymentMock(...args),
    makeRecordPaymentDeps: () => ({
      pendingPaymentCanceller: {
        cancelPendingPayments: async (a: unknown) => {
          order.push('cancel');
          return cancelMock(a);
        },
      },
    }),
  };
});

const adminContext = {
  current: {
    user: {
      id: 'admin-user-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin User',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-pay-cancel-1',
};

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440522';
const routeParams = { params: Promise.resolve({ invoiceId: INVOICE_ID }) };

function paidInvoice(replayed: boolean) {
  return {
    tenantId: 'test-swecham',
    invoiceId: INVOICE_ID,
    memberId: 'member-1',
    planId: null,
    planYear: null,
    status: 'paid',
    fiscalYear: 2026,
    sequenceNumber: 52,
    documentNumber: { raw: 'INV2026-00052' },
    issueDate: '2026-01-10',
    dueDate: '2026-02-10',
    paidAt: '2026-01-15T05:00:00.000Z',
    voidedAt: null,
    currency: 'THB',
    subtotal: null,
    vatRate: null,
    vat: null,
    total: null,
    creditedTotal: { satang: BigInt(0) },
    pdf: null,
    receiptDocumentNumberRaw: null,
    receiptPdfStatus: null,
    receiptPdf: null,
    autoEmailOnIssue: null,
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-01-15T05:00:00.000Z',
    lines: [],
    emailDispatch: 'disabled',
    replayed,
  };
}

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;
async function importRoute() {
  return (await import('@/app/api/invoices/[invoiceId]/pay/route')) as { POST: RoutePost };
}
function post(): NextRequest {
  return new NextRequest(`http://localhost:3100/api/invoices/${INVOICE_ID}/pay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paymentMethod: 'bank_transfer', paymentDate: '2026-01-15' }),
  });
}

describe('contract: POST /api/invoices/[invoiceId]/pay — post-commit PaymentIntent cancel (#452 review M1)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);
  beforeEach(() => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
    cancelMock.mockResolvedValue(undefined);
    order.length = 0;
  });
  afterEach(() => vi.clearAllMocks());

  it('fresh payment → 200; cancel runs AFTER the F2 finaliser with cause invoice_paid_manually', async () => {
    recordPaymentMock.mockResolvedValueOnce(ok(paidInvoice(false)));
    const { POST } = await importRoute();
    const res = await POST(post(), routeParams);
    expect(res.status).toBe(200);
    expect(order).toEqual(['f2-finalise', 'cancel']);
    expect(cancelMock).toHaveBeenCalledWith({
      tenantId: 'test-swecham',
      invoiceId: INVOICE_ID,
      actorUserId: 'admin-user-1',
      requestId: 'req-pay-cancel-1',
      cause: 'invoice_paid_manually',
    });
    // `replayed` is internal — not part of the response body.
    expect(await res.json()).not.toHaveProperty('replayed');
  });

  it('replay (invoice already paid, e.g. by the webhook) → cause invoice_already_paid', async () => {
    recordPaymentMock.mockResolvedValueOnce(ok(paidInvoice(true)));
    const { POST } = await importRoute();
    const res = await POST(post(), routeParams);
    expect(res.status).toBe(200);
    expect(cancelMock).toHaveBeenCalledWith(
      expect.objectContaining({ cause: 'invoice_already_paid' }),
    );
  });

  it('refused payment (409) → no cancel', async () => {
    recordPaymentMock.mockResolvedValueOnce(err({ code: 'invalid_status', status: 'void' }));
    const { POST } = await importRoute();
    const res = await POST(post(), routeParams);
    expect(res.status).toBe(409);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('canceller throws → still 200 (the payment is committed)', async () => {
    recordPaymentMock.mockResolvedValueOnce(ok(paidInvoice(false)));
    cancelMock.mockRejectedValueOnce(new Error('neon: connection reset'));
    const { POST } = await importRoute();
    const res = await POST(post(), routeParams);
    expect(res.status).toBe(200);
  });
});
