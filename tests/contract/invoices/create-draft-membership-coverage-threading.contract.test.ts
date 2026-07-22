/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b review-mandate) —
 * Contract test: POST /api/invoices threads the SAME renewal
 * classification the New-invoice form's advisory context line used into
 * `createInvoiceDraft`'s `membershipCoverage`, server-side and
 * server-authoritatively (the client body never carries this field —
 * `createBodySchema` in route.ts has no such key, so there is nothing for
 * a client to smuggle).
 *
 * Strategy: mirrors `event-draft.contract.test.ts` — mock the
 * infrastructure seams (admin-context, tenant-context, request-id,
 * logger) + `@/modules/invoicing` (keep the REAL `createInvoiceDraftSchema`
 * so the route's own zod parse runs unmodified; override just the
 * use-case + deps factory) + the Task 9 `_lib` helper (so the test
 * controls the classification directly without touching live Neon).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';
import { addMonthsUtc } from '@/lib/dates';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const createInvoiceDraftMock = vi.fn();
const loadMemberRenewalContextMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-invoice-draft-1',
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/app/(staff)/admin/invoices/_lib/member-renewal-context', () => ({
  loadMemberRenewalContext: (...args: unknown[]) => loadMemberRenewalContextMock(...args),
}));

vi.mock('@/modules/invoicing', async (importOriginal) => {
  // Use the real schema so `createInvoiceDraftSchema.parse(...)` in the
  // route validates the ACTUAL `membershipCoverage` shape this test pins.
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    createInvoiceDraft: (...args: unknown[]) => createInvoiceDraftMock(...args),
    makeCreateInvoiceDraftDeps: () => ({}),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  requestId: 'req-invoice-draft-1',
};

const MEMBER_ID = '550e8400-e29b-41d4-a716-446655440000';

const STUB_MEMBERSHIP_INVOICE = {
  tenantId: 'test-swecham',
  invoiceId: 'inv_01TESTMEMBERSHIPDRAFT01',
  memberId: MEMBER_ID,
  planId: 'regular',
  planYear: 2026,
  invoiceSubject: 'membership',
  vatInclusive: false,
  status: 'draft',
  draftByUserId: 'admin-user-1',
  fiscalYear: null,
  sequenceNumber: null,
  documentNumber: null,
  issueDate: null,
  dueDate: null,
  paidAt: null,
  voidedAt: null,
  currency: 'THB',
  subtotal: null,
  vatRate: null,
  vat: null,
  total: null,
  creditedTotal: { satang: BigInt(0) },
  proRatePolicy: null,
  netDays: null,
  pdf: null,
  receiptDocumentNumberRaw: null,
  receiptPdfStatus: null,
  receiptPdf: null,
  autoEmailOnIssue: null,
  billDocumentNumberRaw: null,
  vatTreatment: null,
  zeroRateCertNo: null,
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  lines: [
    {
      lineId: 'line_01TESTMEMBERSHIPLINE01',
      kind: 'membership_fee',
      descriptionTh: 'ค่าสมาชิก Regular',
      descriptionEn: 'Membership Regular',
      unitPrice: { satang: BigInt(1_000_000) },
      quantity: '1.0000',
      proRateFactor: null,
      total: { satang: BigInt(1_000_000) },
      position: 1,
    },
  ],
};

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3100/api/invoices', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importRoute() {
  try {
    return await import('@/app/api/invoices/route');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[Task 9] route not yet implemented. Import error: ${msg}`);
  }
}

const REQUEST_BODY = {
  member_id: MEMBER_ID,
  plan_id: 'regular',
  plan_year: 2026,
};

describe('contract: POST /api/invoices — membershipCoverage server-side threading (Task 9)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
    createInvoiceDraftMock.mockResolvedValue(ok(STUB_MEMBERSHIP_INVOICE));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renewal-classified member → membershipCoverage.window threaded (fromIso=periodTo, toIso=periodTo+term)', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'renewal' },
      periodTo: '2027-06-01',
      termMonths: 12,    });

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest(REQUEST_BODY));

    expect(res.status).toBe(201);
    expect(createInvoiceDraftMock).toHaveBeenCalledTimes(1);
    const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.membershipCoverage).toEqual({
      kind: 'window',
      fromIso: '2027-06-01',
      toIso: addMonthsUtc('2027-06-01', 12),
    });
  });

  it('first_payment with NO open cycle → membershipCoverage OMITTED (from_payment default text)', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,
      currentPeriodFrom: null,
      currentPeriodTo: null,    });

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest(REQUEST_BODY));

    expect(res.status).toBe(201);
    const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('membershipCoverage' in input).toBe(false);
  });

  it('064 — first_payment WITH an open cycle → membershipCoverage.window = the CURRENT period', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,
      currentPeriodFrom: '2026-08-01',
      currentPeriodTo: '2027-08-01',    });

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest(REQUEST_BODY));

    expect(res.status).toBe(201);
    const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
    // The current period is billed verbatim (the draft composer renders it as
    // "August 2026 - July 2027").
    expect(input.membershipCoverage).toEqual({
      kind: 'window',
      fromIso: '2026-08-01',
      toIso: '2027-08-01',
    });
  });

  it('064 — first_payment with an EXPIRED open cycle → membershipCoverage OMITTED (comeback re-anchors at payment)', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,
      // A lapsed member being re-billed: the provisional period ended years
      // ago. Paying this bill triggers the settlement comeback exception
      // (reanchor-first-payment.ts), which re-anchors to the PAYMENT month —
      // so printing this DEAD past window as the §86/4 coverage would
      // contradict the receipt. The route must fall through to the generic
      // `from_payment` wording ("12 months, effective from the month of
      // payment") instead of threading the stale window.
      currentPeriodFrom: '2020-08-01',
      currentPeriodTo: '2021-08-01',
    });

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest(REQUEST_BODY));

    expect(res.status).toBe(201);
    const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('membershipCoverage' in input).toBe(false);
  });

  it('M-1 — first_payment whose current period ends NEXT month → membershipCoverage OMITTED (comeback risk if payment slips)', async () => {
    // Fake ONLY Date (no setTimeout/interval → no async interference) so the
    // route's `new Date()` sees a fixed issue month of 2026-07.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    try {
      loadMemberRenewalContextMock.mockResolvedValueOnce({
        classification: { kind: 'first_payment' },
        periodTo: null,
        termMonths: null,
        // Period ends 2026-08-20 — NEXT month relative to the 2026-07 issue. A
        // payment slipping into August lands after period_to → settlement
        // comeback → a concrete window printed now would contradict the receipt.
        // The route must be conservative and fall back to from_payment.
        currentPeriodFrom: '2025-08-20',
        currentPeriodTo: '2026-08-20',
      });

      const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
      const res = await POST(makePostRequest(REQUEST_BODY));

      expect(res.status).toBe(201);
      const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
      expect('membershipCoverage' in input).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('M-1 — first_payment whose current period ends 2+ months out → concrete window threaded (safe from a normal-timing comeback)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    try {
      loadMemberRenewalContextMock.mockResolvedValueOnce({
        classification: { kind: 'first_payment' },
        periodTo: null,
        termMonths: null,
        // Period ends 2026-10-01 — comfortably beyond next month, so a
        // normal-timing payment (July/August) cannot cross it. Print real dates.
        currentPeriodFrom: '2025-10-01',
        currentPeriodTo: '2026-10-01',
      });

      const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
      const res = await POST(makePostRequest(REQUEST_BODY));

      expect(res.status).toBe(201);
      const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(input.membershipCoverage).toEqual({
        kind: 'window',
        fromIso: '2025-10-01',
        toIso: '2026-10-01',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('not_applicable-classified member → membershipCoverage OMITTED', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'not_applicable', reason: 'terminal_only' },
      periodTo: null,
      termMonths: null,    });

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest(REQUEST_BODY));

    expect(res.status).toBe(201);
    const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('membershipCoverage' in input).toBe(false);
  });

  it('renewal-context lookup THROWS → falls back to omitted membershipCoverage (never blocks draft creation)', async () => {
    loadMemberRenewalContextMock.mockRejectedValueOnce(new Error('Neon blip'));

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest(REQUEST_BODY));

    expect(res.status).toBe(201);
    expect(createInvoiceDraftMock).toHaveBeenCalledTimes(1);
    const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('membershipCoverage' in input).toBe(false);

    const loggerMock = await import('@/lib/logger');
    expect(loggerMock.logger.warn).toHaveBeenCalled();
  });

  it('the client-supplied body has no membershipCoverage key to smuggle (schema surface pin)', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'not_applicable', reason: 'erased' },
      periodTo: null,
      termMonths: null,    });

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({
        ...REQUEST_BODY,
        // A crafted client body trying to smuggle a window — the route's
        // `createBodySchema` has no `membershipCoverage` key, so this is
        // silently dropped by zod (unknown keys ignored) rather than
        // reaching `createInvoiceDraft`.
        membershipCoverage: { kind: 'window', fromIso: '2020-01-01', toIso: '2099-01-01' },
      }),
    );

    expect(res.status).toBe(201);
    const [, input] = createInvoiceDraftMock.mock.calls[0] as [unknown, Record<string, unknown>];
    expect('membershipCoverage' in input).toBe(false);
  });

  it('propagates memberId + tenantId to the renewal-context lookup', async () => {
    loadMemberRenewalContextMock.mockResolvedValueOnce({
      classification: { kind: 'first_payment' },
      periodTo: null,
      termMonths: null,    });

    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    await POST(makePostRequest(REQUEST_BODY));

    expect(loadMemberRenewalContextMock).toHaveBeenCalledWith('test-swecham', MEMBER_ID);
  });

  it('400 invalid_body — never reaches the renewal-context lookup', async () => {
    const { POST } = (await importRoute()) as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest({ plan_id: 'regular', plan_year: 2026 }));

    expect(res.status).toBe(400);
    expect(loadMemberRenewalContextMock).not.toHaveBeenCalled();
    expect(createInvoiceDraftMock).not.toHaveBeenCalled();
  });
});
