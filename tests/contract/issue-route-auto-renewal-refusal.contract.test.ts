/**
 * 107-auto-invoice Task 10 — Contract test:
 * POST /api/invoices/[invoiceId]/issue — refuses an `origin='auto_renewal'`
 * draft (Task 9's paired ship gate).
 *
 * Task 9's `issueAutoDraftedRenewal` builds an extensive duplicate-§86/4
 * barrier (origin/shape check, paid-inclusive content guard, plan-year-drift
 * refusal) — but ALL of it lives inside that use-case's own transaction.
 * This generic route calls the bare `issueInvoice` primitive directly, with
 * only an admin RBAC check + a rate limit standing between an admin's click
 * and a minted §87 number. Until this route refuses an `auto_renewal` draft,
 * every one of Task 9's guards is bypassable by POSTing the same draft id
 * here instead of through the renewals queue.
 *
 * Strategy mirrors `tests/contract/invoices/issue-route-guard.contract.test.ts`
 * (the FIRST contract test for this exact route): mock the infra seams +
 * the invoicing module's use-case/deps factories; the route's own code runs
 * unmodified. `issueInvoice` itself is mocked so a refusal can be proven by
 * "the minting primitive was never even called" — the strongest available
 * proof, in a mocked test, that no §87/bill number was burned (minting is
 * `issueInvoice`'s EXCLUSIVE responsibility; see its own header doc).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const issueInvoiceMock = vi.fn();
const guardGenericRouteIssueOriginMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-issue-auto-renewal-refusal-1',
}));

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: vi.fn(async (..._args: unknown[]) => ({
      success: true,
      reset: Date.now() + 60_000,
    })),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    issueInvoice: (...args: unknown[]) => issueInvoiceMock(...args),
    makeIssueInvoiceDeps: () => ({}),
    guardGenericRouteIssueOrigin: (...args: unknown[]) =>
      guardGenericRouteIssueOriginMock(...args),
    makeGuardGenericRouteIssueOriginDeps: () => ({}),
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
  requestId: 'req-issue-auto-renewal-refusal-1',
};

// A queue-owned draft — same shape a Task 9 cron would have created.
const AUTO_RENEWAL_DRAFT_ID = '550e8400-e29b-41d4-a716-446655440099';
// An ordinary admin-created draft — unaffected by this guard.
const MANUAL_DRAFT_ID = '550e8400-e29b-41d4-a716-446655440098';

// Minimal membership `Invoice` fixture for the pass-through happy path —
// only the fields `serialiseInvoice` reads are populated; irrelevant ones
// are null/empty to keep the fixture legible.
const STUB_ISSUED_MANUAL_INVOICE = {
  tenantId: 'test-swecham',
  invoiceId: MANUAL_DRAFT_ID,
  memberId: 'member-1',
  planId: 'plan-1',
  planYear: 2026,
  invoiceSubject: 'membership' as const,
  vatInclusive: false,
  eventId: null,
  eventRegistrationId: null,
  status: 'issued' as const,
  draftByUserId: 'admin-user-1',
  fiscalYear: 2026,
  sequenceNumber: 12,
  documentNumber: { raw: 'SC2026-00012' },
  issueDate: '2026-07-18',
  dueDate: '2026-08-17',
  paidAt: null,
  voidedAt: null,
  currency: 'THB',
  subtotal: { satang: BigInt(1000000) },
  vatRate: { raw: '0.07' },
  vat: { satang: BigInt(70000) },
  total: { satang: BigInt(1070000) },
  creditedTotal: { satang: BigInt(0) },
  proRatePolicy: null,
  netDays: 30,
  billDocumentNumberRaw: null,
  vatTreatment: 'standard' as const,
  zeroRateCertNo: null,
  pdf: { sha256: 'b'.repeat(64), templateVersion: 3 },
  receiptDocumentNumberRaw: null,
  receiptPdfStatus: null,
  receiptPdf: null,
  autoEmailOnIssue: null,
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
  lines: [],
  emailDispatch: 'disabled' as const,
};

const routeParamsFor = (invoiceId: string) => ({
  params: Promise.resolve({ invoiceId }),
});

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import('@/app/api/invoices/[invoiceId]/issue/route')) as {
    POST: RoutePost;
  };
}

function makePostRequest(invoiceId: string): NextRequest {
  return new NextRequest(`http://localhost:3100/api/invoices/${invoiceId}/issue`, {
    method: 'POST',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/invoices/[invoiceId]/issue — auto_renewal refusal (Task 10)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('422 origin_auto_renewal_use_queue — refuses an auto_renewal draft; NO number minted (issueInvoice never called)', async () => {
    guardGenericRouteIssueOriginMock.mockResolvedValueOnce(
      err({ code: 'origin_auto_renewal_use_queue' }),
    );
    // If the route incorrectly bypassed the guard, this WOULD mint a number —
    // proving the refusal by construction, not just by asserting the mock
    // wasn't configured.
    issueInvoiceMock.mockResolvedValueOnce(
      ok({ ...STUB_ISSUED_MANUAL_INVOICE, invoiceId: AUTO_RENEWAL_DRAFT_ID }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest(AUTO_RENEWAL_DRAFT_ID),
      routeParamsFor(AUTO_RENEWAL_DRAFT_ID),
    );

    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: Record<string, unknown> };
    // Bare typed code — no reason / message / detail leak.
    expect(body.error).toEqual({ code: 'origin_auto_renewal_use_queue' });

    // The rigorous "no number minted" proof: the minting primitive was
    // NEVER invoked. issueInvoice is the exclusive writer of
    // document_number / bill_document_number_raw (applyIssue) — if it never
    // ran, those fields on the real draft row are provably unchanged.
    expect(issueInvoiceMock).not.toHaveBeenCalled();

    expect(guardGenericRouteIssueOriginMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: 'test-swecham',
        invoiceId: AUTO_RENEWAL_DRAFT_ID,
      }),
    );
  });

  it('logs the refusal at WARN with the error code (no reason/message leak)', async () => {
    guardGenericRouteIssueOriginMock.mockResolvedValueOnce(
      err({ code: 'origin_auto_renewal_use_queue' }),
    );

    const { POST } = await importRoute();
    await POST(makePostRequest(AUTO_RENEWAL_DRAFT_ID), routeParamsFor(AUTO_RENEWAL_DRAFT_ID));

    const loggerMock = await import('@/lib/logger');
    const warnCalls = (loggerMock.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const refusalCall = warnCalls.find(
      (c) => typeof c[1] === 'string' && (c[1] as string).includes('refused'),
    );
    expect(refusalCall).toBeDefined();
    const fields = refusalCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      requestId: 'req-issue-auto-renewal-refusal-1',
      tenantId: 'test-swecham',
      invoiceId: AUTO_RENEWAL_DRAFT_ID,
      errorCode: 'origin_auto_renewal_use_queue',
    });
  });

  it('a manual draft issues normally — the guard does not over-block', async () => {
    guardGenericRouteIssueOriginMock.mockResolvedValueOnce(ok(undefined));
    issueInvoiceMock.mockResolvedValueOnce(ok(STUB_ISSUED_MANUAL_INVOICE));

    const { POST } = await importRoute();
    const res = await POST(makePostRequest(MANUAL_DRAFT_ID), routeParamsFor(MANUAL_DRAFT_ID));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['document_number']).toBe('SC2026-00012');
    // Proves the ordinary path still reaches the minting primitive exactly
    // once, with the same invoiceId the guard was asked about.
    expect(issueInvoiceMock).toHaveBeenCalledTimes(1);
  });
});
