/**
 * Task 11 (064-event-invoice-paid-flow) — Contract test:
 * POST /api/invoices/[invoiceId]/issue-as-paid
 *
 * Pins the HTTP contract for the one-shot draft→paid event-invoice issuance:
 *   - 200 happy path (mocked use-case) — paymentMethod defaults to 'other'
 *     when the body omits it; explicit body values thread through.
 *   - 400 invalid body (missing/garbage/impossible paymentDate, bad
 *     paymentMethod, non-JSON body)
 *   - 401/403 forwarded from requireAdminContext (admin-only write)
 *   - 404 invoice_not_found / member_not_found
 *   - 409 invoice_already_issued (sequential double-POST) /
 *         member_archived / settings_missing
 *   - 422 not_event_subject / payment_date_future / payment_date_too_old /
 *         invalid_lines (reason stripped) / overflow / no_buyer_snapshot
 *   - 429 rate-limited (includes Retry-After header)
 *   - 500 pdf_render_failed / blob_upload_failed — `reason` MUST be
 *         stripped from the response body (infra detail, L-carry-forward)
 *   - PII hygiene: paymentReference / paymentNotes never appear in logs.
 *
 * Raw-throw behaviour (40P01 deadlock / 0213 unique backstop): matching
 * every sibling F4 invoice route (issue / pay / event-draft), the route has
 * NO try/catch around the use-case call — a raw throw propagates to Next's
 * default 500 handler, which does not serialise `err.message` into the
 * response in production. Pinned here as "the route never converts a typed
 * error into a body containing `reason`"; raw-throw passthrough is the
 * sibling-consistent contract.
 *
 * Strategy: vi.mock all infrastructure seams (admin-context, tenant-context,
 * request-id, rate-limiter, logger, env) + the invoicing module (use-case +
 * deps factory). The route's own code path runs unmodified — the REAL
 * issueEventInvoiceAsPaidSchema validates the body at the boundary.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const issueEventInvoiceAsPaidMock = vi.fn();
const makeDepsMock = vi.fn((..._args: unknown[]) => ({}));

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-issue-as-paid-1',
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

// F8 flag OFF — the route must not touch @/modules/renewals in this suite
// (the dynamic import is gated on this flag, pay-route parity). Keep the
// REAL env otherwise: the invoicing barrel's module graph reads other env
// fields at import time, so a minimal stub breaks importOriginal below.
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      features: { ...actual.env.features, f8Renewals: false },
    },
  };
});

vi.mock('@/modules/invoicing', async (importOriginal) => {
  // Use the real schema so the route's safeParse boundary validates actual
  // input shapes (paymentDate regex + real-calendar refine, paymentMethod
  // enum). Override only the use-case function + deps factory.
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    issueEventInvoiceAsPaid: (...args: unknown[]) =>
      issueEventInvoiceAsPaidMock(...args),
    makeIssueEventInvoiceAsPaidDeps: (...args: unknown[]) => makeDepsMock(...args),
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
  requestId: 'req-issue-as-paid-1',
};

const VALID_INVOICE_ID = '550e8400-e29b-41d4-a716-446655440064';
// A date guaranteed in the past for Bangkok wall-clock.
const PAST_PAYMENT_DATE = '2026-01-15';

/** A minimal PAID event invoice shape returned by the mocked use-case. */
const STUB_PAID_INVOICE = {
  tenantId: 'test-swecham',
  invoiceId: VALID_INVOICE_ID,
  memberId: null,
  planId: null,
  planYear: null,
  invoiceSubject: 'event',
  vatInclusive: true,
  eventId: 'evt_test_1',
  eventRegistrationId: '550e8400-e29b-41d4-a716-446655440001',
  status: 'paid',
  draftByUserId: 'admin-user-1',
  fiscalYear: 2026,
  sequenceNumber: 41,
  documentNumber: { raw: 'INV2026-00041' },
  issueDate: PAST_PAYMENT_DATE,
  dueDate: PAST_PAYMENT_DATE,
  paidAt: '2026-01-15T05:00:00.000Z',
  voidedAt: null,
  currency: 'THB',
  subtotal: { satang: BigInt(46729) },
  vatRate: { raw: '0.07' },
  vat: { satang: BigInt(3271) },
  total: { satang: BigInt(50000) },
  creditedTotal: { satang: BigInt(0) },
  proRatePolicy: null,
  netDays: null,
  pdf: { sha256: 'a'.repeat(64), templateVersion: 3 },
  receiptDocumentNumberRaw: null,
  receiptPdfStatus: null,
  receiptPdf: null,
  autoEmailOnIssue: null,
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T05:00:00.000Z',
  lines: [
    {
      lineId: 'line_01TESTEVENTLINE00001',
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน TestEvent (2026-01-15)',
      descriptionEn: 'Event: TestEvent (2026-01-15)',
      unitPrice: { satang: BigInt(50000) },
      quantity: '1.0000',
      proRateFactor: null,
      total: { satang: BigInt(50000) },
      position: 1,
    },
  ],
};

const routeParams = { params: Promise.resolve({ invoiceId: VALID_INVOICE_ID }) };

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/issue-as-paid`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

type RoutePost = (
  req: NextRequest,
  ctx: { params: Promise<{ invoiceId: string }> },
) => Promise<Response>;

async function importRoute() {
  try {
    return (await import(
      '@/app/api/invoices/[invoiceId]/issue-as-paid/route'
    )) as { POST: RoutePost };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — Task 11] issue-as-paid route not yet implemented. Import error: ${msg}`,
    );
  }
}

// Helper to access the mocked auth-deps for per-test rate-limit override.
async function getMockedAuthDeps() {
  const mod = await import('@/lib/auth-deps');
  return mod as unknown as { rateLimiter: { check: ReturnType<typeof vi.fn> } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/invoices/[invoiceId]/issue-as-paid (Task 11)', () => {
  // Warm the route-handler import ONCE (event-draft harness parity — the
  // invoicing barrel pulls @react-pdf + Vercel Blob + Sarabun fonts
  // transitively; amortising the cold load removes per-test timeout flakes).
  beforeAll(async () => {
    await importRoute();
  }, 60_000);

  beforeEach(() => {
    requireAdminContextMock.mockResolvedValue(adminContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // AuthN / AuthZ
  // -------------------------------------------------------------------------

  it('401 no-session — unauthenticated request forwarded from requireAdminContext', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), {
        status: 401,
      }),
    });

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(401);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  it('403 forbidden — manager role is rejected before reaching use-case (admin-only write)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
      }),
    });

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(403);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 400 — invalid body (real schema at the boundary)
  // -------------------------------------------------------------------------

  it('400 — missing paymentDate', async () => {
    const { POST } = await importRoute();
    const res = await POST(makePostRequest({}), routeParams);
    expect(res.status).toBe(400);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  it('400 — garbage paymentDate (wrong shape)', async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: '15/01/2026' }),
      routeParams,
    );
    expect(res.status).toBe(400);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  it('400 — impossible calendar date (2026-02-31) caught by the refine, not a 500', async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: '2026-02-31' }),
      routeParams,
    );
    expect(res.status).toBe(400);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  it('400 — paymentMethod outside the enum', async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE, paymentMethod: 'paypal' }),
      routeParams,
    );
    expect(res.status).toBe(400);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  it('400 — paymentReference exceeds the 200-char cap', async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({
        paymentDate: PAST_PAYMENT_DATE,
        paymentReference: 'x'.repeat(201),
      }),
      routeParams,
    );
    expect(res.status).toBe(400);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  it('400 — paymentNotes exceeds the 2000-char cap', async () => {
    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({
        paymentDate: PAST_PAYMENT_DATE,
        paymentNotes: 'x'.repeat(2001),
      }),
      routeParams,
    );
    expect(res.status).toBe(400);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  it('400 — non-JSON body', async () => {
    const { POST } = await importRoute();
    const req = new NextRequest(
      `http://localhost:3100/api/invoices/${VALID_INVOICE_ID}/issue-as-paid`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not valid json',
      },
    );
    const res = await POST(req, routeParams);
    expect(res.status).toBe(400);
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 404 — not found
  // -------------------------------------------------------------------------

  it('404 invoice_not_found — unknown invoiceId (use-case err)', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'invoice_not_found' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invoice_not_found');
  });

  it('404 member_not_found — matched member vanished before issue', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'member_not_found' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('member_not_found');
  });

  // -------------------------------------------------------------------------
  // 409 — conflicts
  // -------------------------------------------------------------------------

  it('409 invoice_already_issued — sequential double-POST: first wins 200, second 409 with status', async () => {
    issueEventInvoiceAsPaidMock
      .mockResolvedValueOnce(ok(STUB_PAID_INVOICE))
      .mockResolvedValueOnce(err({ code: 'invoice_already_issued', status: 'paid' }));

    const { POST } = await importRoute();

    const first = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(first.status).toBe(200);

    const second = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string; status: string } };
    expect(body.error.code).toBe('invoice_already_issued');
    expect(body.error.status).toBe('paid');
  });

  it('409 member_archived — FR-037 archive-race guard', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'member_archived' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('member_archived');
  });

  it('409 settings_missing — tenant invoice settings not configured', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'settings_missing' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('settings_missing');
  });

  // -------------------------------------------------------------------------
  // 422 — unprocessable entity
  // -------------------------------------------------------------------------

  it('422 payment_date_future — Bangkok wall-clock future date', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'payment_date_future' }),
    );

    const { POST } = await importRoute();
    // Schema-valid date; the FUTURE check is Bangkok-clock-relative inside
    // the use-case, so the route forwards it as a typed 422.
    const res = await POST(
      makePostRequest({ paymentDate: '2026-06-09' }),
      routeParams,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payment_date_future');
  });

  it('422 payment_date_too_old — >365-day backdate (typo-year guard, wave-3 S10)', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'payment_date_too_old' }),
    );

    const { POST } = await importRoute();
    // Schema-valid date; the PAST bound is Bangkok-clock-relative inside
    // the use-case (mirrors payment_date_future), so the route forwards it
    // as a typed 422.
    const res = await POST(
      makePostRequest({ paymentDate: '2020-06-09' }),
      routeParams,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('payment_date_too_old');
  });

  it('422 not_event_subject — membership draft cannot use the as-paid path', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'not_event_subject' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_event_subject');
  });

  it('422 invalid_lines — reason is STRIPPED from the response body', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'invalid_lines', reason: 'INTERNAL_LINE_DETAIL' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('invalid_lines');
    expect(body.error).not.toHaveProperty('reason');
  });

  it('422 overflow — fiscalYear context retained (not infra detail)', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'overflow', fiscalYear: 2026 }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('overflow');
  });

  it('422 no_buyer_snapshot — corrupt non-member draft', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'no_buyer_snapshot' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_buyer_snapshot');
  });

  // -------------------------------------------------------------------------
  // 429 — rate limited
  // -------------------------------------------------------------------------

  it('429 rate_limited — includes Retry-After header; use-case never called', async () => {
    const { rateLimiter } = await getMockedAuthDeps();
    rateLimiter.check.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 120_000,
    });

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
    expect(issueEventInvoiceAsPaidMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 500 — infrastructure failures: reason MUST NOT leak
  // -------------------------------------------------------------------------

  it('500 pdf_render_failed — reason stripped from the response body', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'pdf_render_failed', reason: 'FORBIDDEN_FONT_PATH_DETAIL' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('FORBIDDEN_FONT_PATH_DETAIL');
    const body = JSON.parse(raw) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('pdf_render_failed');
    expect(body.error).not.toHaveProperty('reason');
  });

  it('500 blob_upload_failed — reason stripped from the response body', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'blob_upload_failed', reason: 'FORBIDDEN_BLOB_URL_DETAIL' }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(raw).not.toContain('FORBIDDEN_BLOB_URL_DETAIL');
    const body = JSON.parse(raw) as { error: Record<string, unknown> };
    expect(body.error['code']).toBe('blob_upload_failed');
    expect(body.error).not.toHaveProperty('reason');
  });

  // -------------------------------------------------------------------------
  // 200 — happy path
  // -------------------------------------------------------------------------

  it('200 happy — serialised paid invoice; paymentMethod defaults to other when omitted', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(ok(STUB_PAID_INVOICE));

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({ paymentDate: PAST_PAYMENT_DATE }),
      routeParams,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('invoice_id', VALID_INVOICE_ID);
    expect(body).toHaveProperty('status', 'paid');
    expect(body).toHaveProperty('document_number', 'INV2026-00041');
    expect(body).toHaveProperty('paid_at', '2026-01-15T05:00:00.000Z');
    const lines = body['lines'] as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveProperty('kind', 'event_fee');

    // RBAC policy-arg pin: admin-only WRITE on the invoice resource —
    // a drift to a weaker policy (e.g. read) must fail this contract.
    expect(requireAdminContextMock).toHaveBeenCalledWith(expect.anything(), {
      resource: 'invoice',
      action: 'write',
    });

    // Input threading: ids from context, defaults applied by the route.
    expect(issueEventInvoiceAsPaidMock).toHaveBeenCalledTimes(1);
    const input = issueEventInvoiceAsPaidMock.mock.calls[0]![1] as {
      tenantId: string;
      actorUserId: string;
      requestId: string;
      invoiceId: string;
      paymentDate: string;
      paymentMethod: string;
      paymentReference: string | null;
      paymentNotes: string | null;
    };
    expect(input.tenantId).toBe('test-swecham');
    expect(input.actorUserId).toBe('admin-user-1');
    expect(input.requestId).toBe('req-issue-as-paid-1');
    expect(input.invoiceId).toBe(VALID_INVOICE_ID);
    expect(input.paymentDate).toBe(PAST_PAYMENT_DATE);
    expect(input.paymentMethod).toBe('other');
    expect(input.paymentReference).toBeNull();
    expect(input.paymentNotes).toBeNull();
  });

  it('200 happy — explicit paymentMethod / reference / notes thread through', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(ok(STUB_PAID_INVOICE));

    const { POST } = await importRoute();
    const res = await POST(
      makePostRequest({
        paymentDate: PAST_PAYMENT_DATE,
        paymentMethod: 'cash',
        paymentReference: 'door-cash-042',
        paymentNotes: 'Collected at registration desk',
      }),
      routeParams,
    );

    expect(res.status).toBe(200);
    const input = issueEventInvoiceAsPaidMock.mock.calls[0]![1] as {
      paymentMethod: string;
      paymentReference: string | null;
      paymentNotes: string | null;
    };
    expect(input.paymentMethod).toBe('cash');
    expect(input.paymentReference).toBe('door-cash-042');
    expect(input.paymentNotes).toBe('Collected at registration desk');
  });

  // -------------------------------------------------------------------------
  // PII hygiene — paymentReference / paymentNotes MUST NOT appear in logs.
  // -------------------------------------------------------------------------

  it('paymentReference / paymentNotes do NOT leak into pino logs on error path', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'invalid_lines', reason: 'detail' }),
    );

    const { POST } = await importRoute();
    await POST(
      makePostRequest({
        paymentDate: PAST_PAYMENT_DATE,
        paymentMethod: 'bank_transfer',
        paymentReference: 'FORBIDDEN_PAYMENT_REFERENCE',
        paymentNotes: 'FORBIDDEN_PAYMENT_NOTES',
      }),
      routeParams,
    );

    const loggerMock = await import('@/lib/logger');
    const allCalls = [
      ...((loggerMock.logger.warn as ReturnType<typeof vi.fn>).mock?.calls ?? []),
      ...((loggerMock.logger.info as ReturnType<typeof vi.fn>).mock?.calls ?? []),
      ...((loggerMock.logger.error as ReturnType<typeof vi.fn>).mock?.calls ?? []),
    ];
    expect(allCalls.length).toBeGreaterThan(0); // warn fired on the error path
    for (const call of allCalls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain('FORBIDDEN_PAYMENT_REFERENCE');
      expect(serialised).not.toContain('FORBIDDEN_PAYMENT_NOTES');
    }
  });

  it('failure-path warn log carries only requestId/tenantId/invoiceId/errorCode', async () => {
    issueEventInvoiceAsPaidMock.mockResolvedValueOnce(
      err({ code: 'not_event_subject' }),
    );

    const { POST } = await importRoute();
    await POST(makePostRequest({ paymentDate: PAST_PAYMENT_DATE }), routeParams);

    const loggerMock = await import('@/lib/logger');
    const warnCalls = (loggerMock.logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const failureCall = warnCalls.find(
      (c) => typeof c[1] === 'string' && (c[1] as string).includes('failed'),
    );
    expect(failureCall).toBeDefined();
    const fields = failureCall![0] as Record<string, unknown>;
    expect(fields).toMatchObject({
      requestId: 'req-issue-as-paid-1',
      tenantId: 'test-swecham',
      invoiceId: VALID_INVOICE_ID,
      errorCode: 'not_event_subject',
    });
  });
});
