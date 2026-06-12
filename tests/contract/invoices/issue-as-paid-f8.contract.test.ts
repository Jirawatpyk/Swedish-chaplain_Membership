/**
 * 065 review follow-up [Sev 6, item 3] — Contract test:
 * POST /api/invoices/[invoiceId]/issue-as-paid with FEATURE_F8_RENEWALS=true.
 *
 * The main suite (issue-as-paid.contract.test.ts) pins the flag-FALSE arm
 * (deps factory called with `undefined` callbacks). This sibling pins the
 * flag-TRUE arm — the design-panel L-1 parity requirement: a matched-member
 * as-paid issuance must fire the same F4InvoicePaidEvent hooks recordPayment
 * fires, wired as `f8OnPaidCallbacks(tenant slug)` into the deps factory's
 * 2nd argument. Without this pin, a refactor dropping the dynamic-import
 * branch would leave F8 RenewalCycles stuck in `awaiting_payment` after an
 * out-of-band event payment — with every other contract test still green.
 *
 * SEPARATE FILE on purpose: the env mock is evaluated once per module graph,
 * so flipping `f8Renewals` inside the main suite would need a
 * vi.resetModules + re-import dance that re-pays the heavy invoicing-barrel
 * cold load per flip. A sibling file gets its own module graph for free.
 * Mock seams are copied from the main suite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const issueEventInvoiceAsPaidMock = vi.fn();
const makeDepsMock = vi.fn((..._args: unknown[]) => ({}));
// Sentinel callback list — identity-asserted through to the deps factory.
const cbSentinel = { onInvoicePaid: vi.fn() };
const f8OnPaidCallbacksMock = vi.fn((_tenantSlug: string) => [cbSentinel]);

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-issue-as-paid-f8-1',
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
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// F8 flag ON — the ONLY delta from the main suite's env mock. Keep the REAL
// env otherwise (the invoicing barrel reads other env fields at import time).
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      features: { ...actual.env.features, f8Renewals: true },
    },
  };
});

// The route's `await import('@/modules/renewals')` resolves to THIS mock —
// the real renewals barrel must never load in a contract suite.
vi.mock('@/modules/renewals', () => ({
  f8OnPaidCallbacks: (...args: unknown[]) =>
    f8OnPaidCallbacksMock(...(args as [string])),
}));

vi.mock('@/modules/invoicing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    issueEventInvoiceAsPaid: (...args: unknown[]) =>
      issueEventInvoiceAsPaidMock(...args),
    makeIssueEventInvoiceAsPaidDeps: (...args: unknown[]) => makeDepsMock(...args),
  };
});

// ---------------------------------------------------------------------------
// Fixtures — matched-MEMBER paid event invoice (the F8-relevant case).
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
  requestId: 'req-issue-as-paid-f8-1',
};

const VALID_INVOICE_ID = '550e8400-e29b-41d4-a716-446655440088';
const PAST_PAYMENT_DATE = '2026-01-15';

/** Minimal serialisable paid invoice — only the fields serialiseInvoice reads. */
const STUB_PAID_INVOICE = {
  tenantId: 'test-swecham',
  invoiceId: VALID_INVOICE_ID,
  memberId: 'member-1',
  planId: null,
  planYear: null,
  status: 'paid',
  fiscalYear: 2026,
  sequenceNumber: 88,
  documentNumber: { raw: 'INV2026-00088' },
  issueDate: PAST_PAYMENT_DATE,
  dueDate: PAST_PAYMENT_DATE,
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
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T05:00:00.000Z',
  lines: [],
};

const routeParams = { params: Promise.resolve({ invoiceId: VALID_INVOICE_ID }) };

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  return (await import('@/app/api/invoices/[invoiceId]/issue-as-paid/route')) as {
    POST: RoutePost;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/invoices/[invoiceId]/issue-as-paid — FEATURE_F8_RENEWALS=true (065 item 3)', () => {
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 happy — f8OnPaidCallbacks(tenant slug) is wired into the deps factory (design-panel L-1 parity)', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(ok(STUB_PAID_INVOICE));

    const { POST } = await importRoute();
    const res = await POST(
      new NextRequest(
        `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/issue-as-paid`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paymentDate: PAST_PAYMENT_DATE }),
        },
      ),
      routeParams,
    );

    expect(res.status).toBe(200);

    // The dynamic import resolved + the callback factory got the tenant slug.
    expect(f8OnPaidCallbacksMock).toHaveBeenCalledTimes(1);
    expect(f8OnPaidCallbacksMock).toHaveBeenCalledWith('test-swecham');

    // …and the EXACT callback list (identity, not a copy) reached the deps
    // factory as its 2nd argument — the flag-false arm pins `undefined` here.
    expect(makeDepsMock).toHaveBeenCalledTimes(1);
    expect(makeDepsMock).toHaveBeenCalledWith('test-swecham', [cbSentinel]);
    expect(
      (makeDepsMock.mock.calls[0] as unknown[])[1],
    ).toBe(f8OnPaidCallbacksMock.mock.results[0]!.value);
  });
});
