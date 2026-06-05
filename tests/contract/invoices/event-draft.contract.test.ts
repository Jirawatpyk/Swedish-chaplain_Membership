/**
 * Task 12 (054-event-fee-invoices) — Contract test:
 * POST /api/invoices/event-draft
 *
 * Pins the HTTP contract for the event-fee draft creation route:
 *   - 201 happy path (mocked use-case)
 *   - 400 invalid body (bad amountOverride / missing eventRegistrationId)
 *   - 400 invalid JSON
 *   - 403 manager / member → forwarded from requireAdminContext
 *   - 404 registration_not_found / event_not_found
 *   - 409 duplicate
 *   - 422 invalid_amount / no_fee_free_event / buyer_required /
 *         attendee_erased / invalid_tax_id_format / invalid_buyer_snapshot
 *   - 429 rate-limited (includes Retry-After header)
 *   - 500 lookup_failed
 *
 * Strategy: vi.mock all infrastructure seams (admin-context, tenant-context,
 * request-id, rate-limiter, logger) + the invoicing module (use-case + deps
 * factory). The route's own code path runs unmodified.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any import of the route.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const createEventInvoiceDraftMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-event-draft-1',
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
  // Use the real schema so the route's safeParse boundary validates
  // actual input shapes — that is precisely what these contract tests
  // exercise. We override only the use-case function + deps factory.
  const actual = await importOriginal<typeof import('@/modules/invoicing')>();
  return {
    ...actual,
    createEventInvoiceDraft: (...args: unknown[]) =>
      createEventInvoiceDraftMock(...args),
    makeCreateEventInvoiceDraftDeps: () => ({}),
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
  requestId: 'req-event-draft-1',
};

const VALID_REG_ID = '550e8400-e29b-41d4-a716-446655440000';

/** A minimal valid invoice shape returned by the mocked use-case. */
const STUB_INVOICE = {
  tenantId: 'test-swecham',
  invoiceId: 'inv_01TESTEVENTDRAFT00001',
  memberId: null,
  planId: null,
  planYear: null,
  invoiceSubject: 'event',
  vatInclusive: true,
  eventId: 'evt_test_1',
  eventRegistrationId: VALID_REG_ID,
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
  createdAt: '2026-06-04T00:00:00.000Z',
  updatedAt: '2026-06-04T00:00:00.000Z',
  lines: [
    {
      lineId: 'line_01TESTEVENTLINE00001',
      kind: 'event_fee',
      descriptionTh: 'ค่าเข้าร่วมงาน TestEvent (2026-06-04)',
      descriptionEn: 'Event: TestEvent (2026-06-04)',
      unitPrice: { satang: BigInt(50000) },
      quantity: '1.0000',
      proRateFactor: null,
      total: { satang: BigInt(50000) },
      position: 1,
    },
  ],
};

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3100/api/invoices/event-draft', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importRoute() {
  try {
    return await import('@/app/api/invoices/event-draft/route');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — Task 12] route not yet implemented. Import error: ${msg}`,
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

describe('contract: POST /api/invoices/event-draft (Task 12)', () => {
  // Warm the route-handler import ONCE so no individual test bears its cold-load
  // cost (the event-draft route pulls @react-pdf + Vercel Blob + Sarabun fonts +
  // Upstash transitively). `afterEach` clears mocks but NOT modules, so this
  // import is cached for every test. Under the full invoicing contract+unit suite
  // in parallel the cold-load alone can exceed a per-test budget and time out —
  // which ALSO strands an unconsumed mockResolvedValueOnce and trips the next
  // test's call count. Amortising it here removes both flakes (mirrors
  // credit-notes-route.test.ts).
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
  // Happy path
  // -------------------------------------------------------------------------

  it('201 — happy path: member-matched registration with amountOverride', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(ok(STUB_INVOICE));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        amountOverride: 50000,
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    // Serialiser maps invoice_id from the domain aggregate.
    expect(body).toHaveProperty('invoice_id');
    expect(body).toHaveProperty('status', 'draft');
    expect(body).toHaveProperty('member_id', null);
    // Lines serialised correctly.
    const lines = body['lines'] as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveProperty('kind', 'event_fee');
  });

  it('201 — happy path: non-member attendee with buyer object', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(ok(STUB_INVOICE));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        amountOverride: 107000,
        buyer: {
          legal_name: 'Test Company Ltd',
          tax_id: '1234567890123',
          address: '99 Sukhumvit Rd, Bangkok',
          primary_contact_name: 'Jane Doe',
          primary_contact_email: 'jane@test.com',
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(createEventInvoiceDraftMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 400 — invalid body
  // -------------------------------------------------------------------------

  it('400 invalid_json — malformed request body', async () => {
    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const req = new NextRequest('http://localhost:3100/api/invoices/event-draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_json');
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — missing eventRegistrationId', async () => {
    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makePostRequest({ amountOverride: 50000 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — eventRegistrationId is not a uuid', async () => {
    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: 'not-a-uuid', amountOverride: 50000 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — amountOverride is 0 (below min 1)', async () => {
    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID, amountOverride: 0 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — amountOverride exceeds MAX_EVENT_INVOICE_SATANG', async () => {
    // MAX_EVENT_INVOICE_SATANG = 100_000_000 (1,000,000 THB)
    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        amountOverride: 100_000_001,
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — amountOverride is a float (non-integer)', async () => {
    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID, amountOverride: 500.5 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body — buyer.tax_id has wrong format (11 digits)', async () => {
    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        buyer: {
          legal_name: 'Test Co',
          tax_id: '12345678901', // 11 digits, not 13
          address: '1 Test Rd',
          primary_contact_name: 'John',
          primary_contact_email: '',
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 403 — RBAC
  // -------------------------------------------------------------------------

  it('403 forbidden — manager role is rejected before reaching use-case', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
      }),
    });

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID }),
    );
    expect(res.status).toBe(403);
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  it('401 no-session — unauthenticated request forwarded from requireAdminContext', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), {
        status: 401,
      }),
    });

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID }),
    );
    expect(res.status).toBe(401);
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 404 — domain not found
  // -------------------------------------------------------------------------

  it('404 registration_not_found — use-case returns registration_not_found', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'registration_not_found' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('registration_not_found');
  });

  it('404 event_not_found — use-case returns event_not_found', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'event_not_found' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('event_not_found');
  });

  // -------------------------------------------------------------------------
  // 409 — duplicate
  // -------------------------------------------------------------------------

  it('409 duplicate — a non-void event invoice already exists for this registration', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'duplicate' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('duplicate');
  });

  // -------------------------------------------------------------------------
  // 422 — unprocessable entity
  // -------------------------------------------------------------------------

  it('422 invalid_amount — amount exceeds MAX_EVENT_INVOICE_SATANG after domain check', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'invalid_amount' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID, amountOverride: 50000 }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_amount');
  });

  it('422 no_fee_free_event — registration has no ticket price and no override', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'no_fee_free_event' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_fee_free_event');
  });

  it('422 buyer_required — non-member registration missing buyer object', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'buyer_required' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID, amountOverride: 50000 }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('buyer_required');
  });

  it('422 attendee_erased — GDPR-purged attendee cannot be invoiced', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'attendee_erased' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID, amountOverride: 50000 }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('attendee_erased');
  });

  it('422 invalid_tax_id_format — buyer tax_id has wrong format (domain-level check)', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'invalid_tax_id_format' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        amountOverride: 50000,
        buyer: {
          legal_name: 'Test Co',
          tax_id: '1234567890123',
          address: '1 Test Rd',
          primary_contact_name: 'John',
          primary_contact_email: '',
        },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_tax_id_format');
  });

  it('422 invalid_buyer_snapshot — domain snapshot construction failed', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'invalid_buyer_snapshot' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        amountOverride: 50000,
        buyer: {
          legal_name: 'Test Co',
          tax_id: null,
          address: '1 Test Rd',
          primary_contact_name: 'John',
          primary_contact_email: '',
        },
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_buyer_snapshot');
  });

  // -------------------------------------------------------------------------
  // 429 — rate limited
  // -------------------------------------------------------------------------

  it('429 rate_limited — includes Retry-After header', async () => {
    const { rateLimiter } = await getMockedAuthDeps();
    rateLimiter.check.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 120_000,
    });

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).not.toBeNull();
    expect(createEventInvoiceDraftMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 500 — infrastructure failure
  // -------------------------------------------------------------------------

  it('500 lookup_failed — use-case returns lookup_failed', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'lookup_failed' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makePostRequest({ eventRegistrationId: VALID_REG_ID, amountOverride: 50000 }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('lookup_failed');
  });

  // -------------------------------------------------------------------------
  // Use-case wiring — pins that actorUserId + tenantId thread correctly.
  // -------------------------------------------------------------------------

  it('passes tenantId + actorUserId + requestId + eventRegistrationId to use-case', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(ok(STUB_INVOICE));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        amountOverride: 50000,
      }),
    );

    expect(createEventInvoiceDraftMock).toHaveBeenCalledTimes(1);
    // Second arg is the input object.
    const input = createEventInvoiceDraftMock.mock.calls[0]![1] as {
      tenantId: string;
      actorUserId: string;
      requestId: string;
      eventRegistrationId: string;
    };
    expect(input.tenantId).toBe('test-swecham');
    expect(input.actorUserId).toBe('admin-user-1');
    expect(input.requestId).toBe('req-event-draft-1');
    expect(input.eventRegistrationId).toBe(VALID_REG_ID);
  });

  // -------------------------------------------------------------------------
  // PII hygiene — buyer fields MUST NOT appear in logs.
  // -------------------------------------------------------------------------

  it('buyer fields do NOT leak into pino warn logs on error path', async () => {
    createEventInvoiceDraftMock.mockResolvedValueOnce(
      err({ code: 'invalid_buyer_snapshot' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    await POST(
      makePostRequest({
        eventRegistrationId: VALID_REG_ID,
        amountOverride: 50000,
        buyer: {
          legal_name: 'FORBIDDEN_BUYER_NAME',
          tax_id: null,
          address: 'FORBIDDEN_ADDRESS',
          primary_contact_name: 'FORBIDDEN_CONTACT',
          primary_contact_email: 'forbidden@test.com',
        },
      }),
    );

    const loggerMock = await import('@/lib/logger');
    const allCalls = [
      ...((loggerMock.logger.warn as ReturnType<typeof vi.fn>).mock?.calls ?? []),
      ...((loggerMock.logger.info as ReturnType<typeof vi.fn>).mock?.calls ?? []),
      ...((loggerMock.logger.error as ReturnType<typeof vi.fn>).mock?.calls ?? []),
    ];
    for (const call of allCalls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain('FORBIDDEN_BUYER_NAME');
      expect(serialised).not.toContain('FORBIDDEN_ADDRESS');
      expect(serialised).not.toContain('FORBIDDEN_CONTACT');
      expect(serialised).not.toContain('forbidden@test.com');
    }
  });
});
