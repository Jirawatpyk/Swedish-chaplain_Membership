/**
 * Contract: POST /api/invoices/[invoiceId]/pay emits a `Server-Timing` header
 * on every response and one `pay.timing` log line, so a slow mark-paid can be
 * attributed to a step (auth, rate limit, recordPayment and its inner steps,
 * F2 finaliser) from DevTools or the Vercel runtime logs.
 *
 * recordPayment is mocked; the mock drives the `stepTimer` the route hands it
 * so the header is shown to carry the use-case's inner steps too.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const recordPaymentMock = vi.fn();
const loggerInfo = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/request-id', () => ({ requestIdFromHeaders: () => 'req-pay-timing-1' }));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async (..._args: unknown[]) => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: (...a: unknown[]) => loggerInfo(...a), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: { ...actual.env, features: { ...actual.env.features, f8Renewals: false } },
  };
});
vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    recordPayment: (...args: unknown[]) => recordPaymentMock(...args),
    makeRecordPaymentDeps: () => ({}),
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
  requestId: 'req-pay-timing-1',
};

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440525';
const routeParams = { params: Promise.resolve({ invoiceId: INVOICE_ID }) };

const PAID = {
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
};

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

function stepNames(header: string | null): string[] {
  return (header ?? '').split(',').map((p) => p.trim().split(';')[0]!);
}

describe('contract: POST /api/invoices/[invoiceId]/pay — Server-Timing', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);
  beforeEach(() => requireApiPermissionMock.mockResolvedValue(adminContext));
  afterEach(() => vi.clearAllMocks());

  it('200 → header carries route + use-case steps and a total; one pay.timing log line', async () => {
    recordPaymentMock.mockImplementationOnce(
      async (deps: { stepTimer: { time: (n: string, f: () => Promise<unknown>) => Promise<unknown> } }) => {
        await deps.stepTimer.time('tx.receipt_pdf', async () => undefined);
        await deps.stepTimer.time('tx', async () => undefined);
        return ok(PAID);
      },
    );
    const { POST } = await importRoute();
    const res = await POST(post(), routeParams);
    expect(res.status).toBe(200);
    const header = res.headers.get('Server-Timing');
    expect(header).toMatch(/^([a-z_.]+;dur=[\d.]+)(, [a-z_.]+;dur=[\d.]+)*$/);
    expect(stepNames(header)).toEqual([
      'auth',
      'rate_limit',
      'tx.receipt_pdf',
      'tx',
      'record_payment',
      'total',
    ]);
    const line = loggerInfo.mock.calls.find((c) => c[1] === 'pay.timing');
    expect(line?.[0]).toMatchObject({
      requestId: 'req-pay-timing-1',
      invoiceId: INVOICE_ID,
      status: 200,
    });
    expect((line?.[0] as { steps: Array<{ name: string }> }).steps.map((s) => s.name)).toContain(
      'record_payment',
    );
  });

  it('refused payment (409) → still timed', async () => {
    recordPaymentMock.mockResolvedValueOnce(err({ code: 'invalid_status', status: 'void' }));
    const { POST } = await importRoute();
    const res = await POST(post(), routeParams);
    expect(res.status).toBe(409);
    expect(stepNames(res.headers.get('Server-Timing'))).toEqual([
      'auth',
      'rate_limit',
      'record_payment',
      'total',
    ]);
  });

  it('auth refusal → the auth response is timed too', async () => {
    const { NextResponse } = await import('next/server');
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 }),
    });
    const { POST } = await importRoute();
    const res = await POST(post(), routeParams);
    expect(res.status).toBe(403);
    expect(stepNames(res.headers.get('Server-Timing'))).toEqual(['auth', 'total']);
    expect(recordPaymentMock).not.toHaveBeenCalled();
  });
});
