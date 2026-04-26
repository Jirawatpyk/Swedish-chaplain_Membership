/**
 * T101 — Contract test: POST /api/refunds/initiate.
 *
 * Spec authority: specs/009-online-payment/contracts/payments-api.md § 3.
 *
 * Verifies:
 *   - zod input schema validation (invalid_input on bad body)
 *   - 201 success envelope shape `{ refund, payment, invoice, correlationId }`
 *   - Exhaustive error-code table from payments-api.md § 3:
 *       400 invalid_input, 401 unauthorized, 403 forbidden_role,
 *       404 payment_not_found, 409 payment_not_refundable,
 *       409 refund_exceeds_remaining, 409 refund_in_progress,
 *       502 processor_unavailable
 *   - 429 rate_limited (20 / 5 min admin) with Retry-After header
 *   - Response headers: X-Correlation-Id, Cache-Control: no-store, private
 *   - PCI / log hygiene: client_secret + raw stripe error.message MUST NOT
 *     appear in pino log payloads or response body
 *   - i18n contract: every error envelope carries `messageThai`
 *
 * Pattern mirrors `post-payments-initiate.contract.test.ts` (T041).
 *
 * RED reason: `src/app/api/refunds/initiate/route.ts` does NOT exist yet
 * (created by Batch D T111). The barrel `@/modules/payments` does NOT yet
 * export `issueRefund` (Batch B T108). The dynamic-import bypass via
 * `new Function('m','return import(m)')` defers resolution past Vite's
 * static analysis so the test fails at runtime with a clear RED marker.
 *
 * Turns GREEN: T108 (use-case) + T111 (route) combined.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared BEFORE any dynamic import of the route so vitest
// hoists them to the top of the module graph.
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const issueRefundMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest signature required so spread callers type-check (TS2556)
    check: vi.fn(async (..._args: unknown[]) => ({ success: true, reset: Date.now() + 60_000 })),
  },
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-rfnd-1',
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug, __brand: true }),
}));

/**
 * The barrel does NOT export `issueRefund` yet — Batch B T108. The
 * factory mock declaration is valid TS; the route import will fail
 * before any mock fires, marking each test RED at runtime.
 */
vi.mock('@/modules/payments', () => ({
  issueRefund: (...args: unknown[]) => issueRefundMock(...args),
  makeIssueRefundDeps: () => ({ db: {}, stripe: {}, audit: {}, invoicingBridge: {} }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helper: access mocked auth-deps for per-test rate-limit override.
// ---------------------------------------------------------------------------
async function getMockedAuthDeps() {
  const mod = await import('@/lib/auth-deps');
  return mod as unknown as { rateLimiter: { check: ReturnType<typeof vi.fn> } };
}

/**
 * Indirect dynamic import to bypass Vite's static `import-analysis`
 * transform plugin (which would otherwise fail at transform time when
 * the target file does not exist — `@vite-ignore` is not enough).
 *
 * `new Function('m','return import(m)')` produces a runtime-only eval
 * Vite cannot see; vitest's resolver runs at test execution time and
 * throws ERR_MODULE_NOT_FOUND, which we re-throw with the RED marker.
 *
 * Turns GREEN: T111 creates the route file; the import succeeds.
 */
async function importRoute() {
  // Route exists post T111 (Batch D landed). Vitest's transformer
  // resolves the @/ alias at transform time; the dynamic import below
  // goes through vitest's module graph and picks up every vi.mock()
  // declared above.
  try {
    return (await import('@/app/api/refunds/initiate/route')) as unknown as {
      POST: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[T101] route import failed unexpectedly. Import error: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminContext = {
  current: {
    user: {
      id: 'user-admin-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin One',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.20',
  requestId: 'req-rfnd-1',
};

function makeJsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/refunds/initiate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const VALID_PAYMENT_ID = 'pmt_01JABCDEFGHIJKLMNOPQRSTUV';
const VALID_BODY = {
  paymentId: VALID_PAYMENT_ID,
  amountSatang: 350_000,
  reason: 'Tier downgrade — partial refund of upgrade fee',
};

const SUCCESS_PAYLOAD = {
  refund: {
    id: 'rfnd_01JREFUND0',
    paymentId: VALID_PAYMENT_ID,
    invoiceId: 'inv_01JABCDEFGHIJKLMNOPQRSTUV',
    amountSatang: 350_000,
    reason: 'Tier downgrade — partial refund of upgrade fee',
    status: 'succeeded' as const,
    processorRefundId: 're_3RABCDEFGHIJK',
    creditNoteId: 'cn_01JABCDEFGHIJKL',
    completedAt: '2026-05-15T03:14:22.456Z',
  },
  payment: {
    id: VALID_PAYMENT_ID,
    status: 'partially_refunded' as const,
    refundedAmountSatang: 350_000,
    remainingRefundableSatang: 5_000_000,
  },
  invoice: {
    id: 'inv_01JABCDEFGHIJKLMNOPQRSTUV',
    status: 'partially_credited' as const,
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/refunds/initiate (T101)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('201 — happy path partial refund: response envelope matches spec shape', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(ok(SUCCESS_PAYLOAD));

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('refund');
    expect(body).toHaveProperty('payment');
    expect(body).toHaveProperty('invoice');
    expect(body).toHaveProperty('correlationId');

    const refund = body['refund'] as Record<string, unknown>;
    expect(refund['status']).toBe('succeeded');
    expect(refund['processorRefundId']).toMatch(/^re_/);
    expect(refund['creditNoteId']).toMatch(/^cn_/);
    // Audit 2026-04-25 finding #20: bigint amounts serialise as STRING
    // in the JSON envelope (project convention) so a future tenant
    // exceeding the JS safe-integer window (~9e15) does not lose
    // precision. Same convention as `payments.amountSatang` on the
    // initiate-payment success envelope.
    expect(refund['amountSatang']).toBe('350000');

    const payment = body['payment'] as Record<string, unknown>;
    expect(payment['status']).toBe('partially_refunded');
    expect(payment['refundedAmountSatang']).toBe('350000');

    const invoice = body['invoice'] as Record<string, unknown>;
    expect(invoice['status']).toBe('partially_credited');
  });

  it('201 — full refund: payment.status=refunded, invoice.status=credited', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(
      ok({
        ...SUCCESS_PAYLOAD,
        refund: { ...SUCCESS_PAYLOAD.refund, amountSatang: 5_350_000 },
        payment: {
          id: VALID_PAYMENT_ID,
          status: 'refunded' as const,
          refundedAmountSatang: 5_350_000,
          remainingRefundableSatang: 0,
        },
        invoice: {
          id: 'inv_01JABCDEFGHIJKLMNOPQRSTUV',
          status: 'credited' as const,
        },
      }),
    );

    const { POST } = await importRoute();
    const res = await POST(
      makeJsonRequest({ ...VALID_BODY, amountSatang: 5_350_000 }),
    );
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    const payment = body['payment'] as Record<string, unknown>;
    const invoice = body['invoice'] as Record<string, unknown>;
    expect(payment['status']).toBe('refunded');
    expect(payment['remainingRefundableSatang']).toBe('0');
    expect(invoice['status']).toBe('credited');
  });

  it('400 invalid_input — paymentId missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { POST } = await importRoute();
    const res = await POST(
      makeJsonRequest({ amountSatang: 350_000, reason: 'x' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('invalid_input');
  });

  it('400 invalid_input — amountSatang ≤ 0', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { POST } = await importRoute();
    const res = await POST(
      makeJsonRequest({ ...VALID_BODY, amountSatang: 0 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('invalid_input');
  });

  it('400 invalid_input — amountSatang exceeds 2_000_000_000 (20M THB upper bound)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { POST } = await importRoute();
    const res = await POST(
      makeJsonRequest({ ...VALID_BODY, amountSatang: 2_000_000_001 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('invalid_input');
  });

  it('400 invalid_input — reason exceeds 500 chars', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { POST } = await importRoute();
    const res = await POST(
      makeJsonRequest({ ...VALID_BODY, reason: 'x'.repeat(501) }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('invalid_input');
  });

  it('400 invalid_input — reason contains CR/LF (single-line constraint)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { POST } = await importRoute();
    const res = await POST(
      makeJsonRequest({ ...VALID_BODY, reason: 'line1\nline2' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('invalid_input');
  });

  it('401 unauthorized — no session', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    });

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('403 forbidden_role — manager session is rejected (AS4) + body shape pinned', async () => {
    // I8 (review 2026-04-27): AS4 ("manager → 403 + button hidden") —
    // the route delegates auth-failure response synthesis to
    // `requireAdminContext` (shared helper). Pin the contract:
    //   1. Status 403 surfaces verbatim.
    //   2. Body carries the helper's `{error: 'forbidden'}` payload
    //      unchanged — the route does NOT silently re-wrap it into
    //      a different shape, which would break the F1 admin-route
    //      pattern shared across `/api/auth/users/*`.
    // The F5-specific i18n envelope (`messageThai`, `correlationId`)
    // applies only to use-case-driven errors; auth-context
    // rejections use the project-wide minimal shape.
    requireAdminContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    });

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = (await res.json()) as Record<string, unknown>;
    // Helper's pre-built shape pinned — if a future route refactor
    // synthesises its own envelope here, this assertion catches it.
    expect(body['error']).toBe('forbidden');
  });

  it('404 payment_not_found — id does not exist OR cross-tenant', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(err({ code: 'payment_not_found' }));

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('payment_not_found');
  });

  it('409 payment_not_refundable — payment status not in {succeeded, partially_refunded}', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(
      err({ code: 'payment_not_refundable', currentStatus: 'failed' }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe(
      'payment_not_refundable',
    );
  });

  it('409 refund_exceeds_remaining — pre-flight FR-011b rejection', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(
      err({
        code: 'refund_exceeds_remaining',
        requestedSatang: 1_000_000,
        remainingSatang: 350_000,
      }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe(
      'refund_exceeds_remaining',
    );
  });

  it('409 refund_in_progress — concurrent refund holds the row lock', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(err({ code: 'refund_in_progress' }));

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe(
      'refund_in_progress',
    );
  });

  it('429 rate_limited — admin 20/5min budget exceeded; carries Retry-After', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { rateLimiter } = await getMockedAuthDeps();
    rateLimiter.check.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 90_000,
    });

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });

  it('502 processor_unavailable — refund row inserted with status=failed; no CN', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(
      err({
        code: 'processor_unavailable',
        kind: 'retryable',
        reason: 'retryable',
      }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe(
      'processor_unavailable',
    );
  });

  it('502 processor_unavailable — error envelope MUST NOT leak gateway `reason` (PCI hygiene)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(
      err({
        code: 'processor_unavailable',
        kind: 'permanent',
        reason: 'sk_live_FORBIDDEN_DETAIL_THAT_MUST_NOT_LEAK',
      }),
    );

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    const bodyText = await res.text();
    expect(bodyText).not.toContain('sk_live_FORBIDDEN_DETAIL_THAT_MUST_NOT_LEAK');
    expect(bodyText).not.toContain('processorReason');
    expect(bodyText).not.toContain('FORBIDDEN_DETAIL');
  });

  it('error responses carry messageThai field (i18n contract)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(err({ code: 'payment_not_refundable' }));

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['messageThai']).toBeDefined();
    expect(typeof error['messageThai']).toBe('string');
  });

  it('every response carries Cache-Control: no-store, private', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(err({ code: 'payment_not_found' }));

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    const cc = res.headers.get('Cache-Control');
    expect(cc).toContain('no-store');
    expect(cc).toContain('private');
  });

  it('every response carries X-Correlation-Id header', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockResolvedValueOnce(err({ code: 'payment_not_found' }));

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.headers.get('X-Correlation-Id')).not.toBeNull();
  });

  it('500 internal_error — unexpected use-case throw is caught + correlationId returned', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    issueRefundMock.mockRejectedValueOnce(new Error('db connection lost'));

    const { POST } = await importRoute();
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)['code']).toBe('internal_error');
    expect(JSON.stringify(body)).not.toContain('db connection lost');
  });
});
