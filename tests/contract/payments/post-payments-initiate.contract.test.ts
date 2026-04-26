/**
 * T041 — Contract test: POST /api/payments/initiate.
 *
 * Spec authority: specs/009-online-payment/contracts/payments-api.md § 1.
 *
 * Verifies:
 *   - Zod input schema validation (invalid_input on bad body)
 *   - 201 response envelope: { payment, stripe, correlationId }
 *   - Exhaustive error-code table from payments-api.md § 1
 *   - Rate-limit header present on 429
 *
 * Pattern mirrors tests/contract/tenant-invoice-settings-logo-route.test.ts:
 *   vi.mock all infrastructure seams; dynamic-import the route handler;
 *   assert HTTP contract without touching Redis / Stripe / Postgres.
 *
 * RED reason: `src/app/api/payments/initiate/route.ts` does NOT exist yet
 * (created by Group C T047). Each test imports the route with
 * `/* @vite-ignore *\/` so Vite skips static resolution and lets the
 * import throw ERR_MODULE_NOT_FOUND at runtime. Tests catch that error
 * and re-throw it as a vitest failure with a clear "RED until T047"
 * message. `pnpm typecheck` passes because `@ts-expect-error` suppresses
 * TS2307 on each import line.
 *
 * Turns GREEN: Group C T047 (route handler) + Group D T051
 * (initiatePayment use-case) combined.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock seams — declared before any dynamic import of the route.
// ---------------------------------------------------------------------------

const requireMemberContextMock = vi.fn();
const initiatePaymentMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
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
  requestIdFromHeaders: () => 'req-pay-1',
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug, __brand: true }),
}));

/**
 * Route now imports `auditRepo` via the composition adapter at
 * `@/lib/stripe-webhook-deps` for the Threat F-09 rate-limit audit
 * emission (Group F Review-Gate). Mock the composition layer so the
 * 429 branch doesn't reach live Postgres.
 */
vi.mock('@/lib/stripe-webhook-deps', () => ({
  auditRepo: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest signature required so spread callers type-check (TS2556)
    append: vi.fn(async (..._args: unknown[]) => undefined),
  },
}));

/**
 * @/modules/payments barrel does NOT export `initiatePayment` yet — Group D T051.
 * The mock declaration is valid TypeScript; the route import will fail before
 * any mock is invoked, making tests RED at runtime.
 */
vi.mock('@/modules/payments', () => ({
  initiatePayment: (...args: unknown[]) => initiatePaymentMock(...args),
  makeInitiatePaymentDeps: () => ({ db: {}, stripe: {}, audit: {} }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Helper: access the mocked auth-deps module for per-test rate-limit override.
// ---------------------------------------------------------------------------
async function getMockedAuthDeps() {
  const mod = await import('@/lib/auth-deps');
  return mod as unknown as { rateLimiter: { check: ReturnType<typeof vi.fn> } };
}

/**
 * Attempt to import the route using an indirect dynamic import that Vite's
 * static import-analysis plugin cannot resolve at transform time.
 *
 * WHY `new Function('m', 'return import(m)')`:
 *   Vite's `vite:import-analysis` plugin statically resolves all `import(...)`
 *   calls at transform time and fails when the target file doesn't exist —
 *   even with `@vite-ignore`. Using `new Function` delays the import to a
 *   pure-runtime eval that Vite never sees, so the transform succeeds.
 *   At runtime vitest resolves the alias via its own resolver; if the file
 *   does not exist the import throws ERR_MODULE_NOT_FOUND, which we catch
 *   and re-throw as a clear RED-state failure message.
 *
 * Turns GREEN: Group C T047 creates the file; the import succeeds.
 */
async function importRoute() {
  // Route file now exists (Group F T069). Vitest's transformer resolves
  // the @/ alias at transform time; the direct dynamic import below
  // goes through vitest's module graph and picks up every vi.mock()
  // declared above.
  try {
    return await import('@/app/api/payments/initiate/route');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — T041] route not yet implemented (Group C T047). Import error: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const memberContext = {
  current: {
    user: {
      id: 'user-member-1',
      email: 'member@swecham.test',
      role: 'member' as const,
      status: 'active' as const,
      displayName: 'Member One',
    },
    session: { id: 'sess-member-1' },
    memberId: 'member-company-1',
  },
  sourceIp: '203.0.113.10',
  requestId: 'req-pay-1',
};

function makeJsonRequest(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/payments/initiate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const VALID_INVOICE_ID = 'inv_01JABCDEFGHIJKLMNOPQRSTUV'; // 26 chars ULID-shaped
const VALID_BODY = { invoiceId: VALID_INVOICE_ID, method: 'card' as const };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/payments/initiate (T041)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('201 — happy path card: response envelope matches spec shape', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    // Canonical flat shape (audit 2026-04-25 finding #19): mock returns
    // the exact `InitiatePaymentSuccess` interface from the use-case.
    // Route now ONLY accepts this shape — the previous nested
    // `{ payment, stripe }` test fixture was a contract drift that
    // forced the route to handle two shapes.
    initiatePaymentMock.mockResolvedValueOnce(
      ok({
        payment: {
          id: 'pmt_01JABCDE',
          invoiceId: VALID_INVOICE_ID,
          method: 'card',
          status: 'pending',
          amountSatang: 5_350_000,
          currency: 'THB',
          attemptSeq: 1,
          initiatedAt: '2026-05-12T07:03:11.123Z',
          processorEnvironment: 'test',
        },
        clientSecret: 'pi_test_xxx_secret_yyy',
        publishableKey: 'pk_test_xxx',
        paymentIntentId: 'pi_test_xxx',
        promptpayQrSvgUrl: null,
        resumed: false,
      }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('payment');
    expect(body).toHaveProperty('stripe');
    expect(body).toHaveProperty('correlationId');

    const payment = body['payment'] as Record<string, unknown>;
    expect(payment['status']).toBe('pending');
    expect(payment['method']).toBe('card');
    expect(payment['currency']).toBe('THB');

    const stripe = body['stripe'] as Record<string, unknown>;
    expect(stripe).toHaveProperty('publishableKey');
    expect(stripe).toHaveProperty('clientSecret');
    expect(stripe).toHaveProperty('paymentIntentId');
    expect(stripe['promptpayQrSvgUrl']).toBeNull();

    // PCI SAQ-A F6 (Group B deferred, 2026-04-24): `clientSecret` is a
    // short-lived Stripe confirmation token — not cardholder data, but
    // long-lived logging of it weakens SAQ-A because the secret grants
    // capture authority for the PaymentIntent's TTL. Verify no logger
    // call ingested the field in any capacity.
    const loggerMock = await import('@/lib/logger');
    const allLoggerCalls = [
      ...((loggerMock.logger.info as ReturnType<typeof vi.fn>).mock?.calls ?? []),
      ...((loggerMock.logger.warn as ReturnType<typeof vi.fn>).mock?.calls ?? []),
      ...((loggerMock.logger.error as ReturnType<typeof vi.fn>).mock?.calls ?? []),
      ...((loggerMock.logger.debug as ReturnType<typeof vi.fn>).mock?.calls ?? []),
    ];
    for (const call of allLoggerCalls) {
      const serialised = JSON.stringify(call);
      expect(serialised).not.toContain('pi_test_xxx_secret_yyy');
    }
  });

  it('201 — happy path promptpay: promptpayQrSvgUrl populated', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(
      ok({
        payment: {
          id: 'pmt_01JABCDE',
          invoiceId: VALID_INVOICE_ID,
          method: 'promptpay',
          status: 'pending',
          amountSatang: 5_350_000,
          currency: 'THB',
          attemptSeq: 1,
          initiatedAt: '2026-05-12T07:03:11.123Z',
          processorEnvironment: 'test',
        },
        clientSecret: 'pi_test_yyy_secret_zzz',
        publishableKey: 'pk_test_xxx',
        paymentIntentId: 'pi_test_yyy',
        promptpayQrSvgUrl: 'data:image/svg+xml;base64,abc==',
        resumed: false,
      }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest({ invoiceId: VALID_INVOICE_ID, method: 'promptpay' }));
    expect(res.status).toBe(201);

    const body = await res.json() as Record<string, unknown>;
    const stripe = body['stripe'] as Record<string, unknown>;
    expect(typeof stripe['promptpayQrSvgUrl']).toBe('string');
  });

  it('400 invalid_input — invoiceId missing', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest({ method: 'card' }));
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invalid_input');
  });

  it('400 invalid_input — method is not card or promptpay', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest({ invoiceId: VALID_INVOICE_ID, method: 'bitcoin' }));
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invalid_input');
  });

  it('400 invalid_input — invoiceId too short (< 20 chars)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest({ invoiceId: 'short', method: 'card' }));
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invalid_input');
  });

  // PCI F-02 / Threat OQ-1 / Constitution Principle I (Group F Review-
  // Gate fix): the HTTP boundary MUST collapse "invoice does not exist"
  // and "invoice in a different tenant" into a single opaque 403 +
  // `invoice_not_accessible` so the client cannot enumerate cross-
  // tenant existence. The use-case still emits the distinct
  // `payment_cross_tenant_probe` audit row on the cross-tenant branch —
  // only the HTTP surface is collapsed.
  it('403 invoice_not_accessible — use-case returns invoice_not_found (collapsed)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(err({ code: 'invoice_not_found' }));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invoice_not_accessible');
  });

  it('409 invoice_not_payable — invoice already paid', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(
      err({ code: 'invoice_not_payable', currentStatus: 'paid' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invoice_not_payable');
  });

  it('409 online_payment_disabled — feature flag off', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(err({ code: 'online_payment_disabled' }));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('online_payment_disabled');
  });

  it('409 method_not_enabled — promptpay requested but not in tenant settings', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(
      err({ code: 'method_not_enabled', requestedMethod: 'promptpay' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeJsonRequest({ invoiceId: VALID_INVOICE_ID, method: 'promptpay' }),
    );
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('method_not_enabled');
  });

  it('422 tenant_settings_incomplete — processor_publishable_key missing', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(
      err({
        code: 'tenant_settings_incomplete',
        reason: 'missing_publishable_key',
      }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('tenant_settings_incomplete');
  });

  it('429 rate_limited — includes Retry-After header', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    const { rateLimiter } = await getMockedAuthDeps();
    rateLimiter.check.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 120_000,
    });

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(429);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });

  it('502 processor_unavailable retryable — includes Retry-After header', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(
      err({
        code: 'processor_unavailable',
        kind: 'retryable',
        reason: 'retryable',
      }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('processor_unavailable');
    // Retryable transient failures MUST advertise a back-off window
    // so the client can pace its retries.
    expect(res.headers.get('Retry-After')).not.toBeNull();
  });

  it('502 processor_unavailable permanent — does NOT include Retry-After (would mislead clients)', async () => {
    // Permanent processor errors (PromptPay-not-enabled, country
    // mismatch, key-environment mismatch) never recover within the
    // back-off window. Sending Retry-After: 30 misleads upstream
    // proxies + monitoring into thinking a retry would help.
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(
      err({
        code: 'processor_unavailable',
        kind: 'permanent',
        reason: 'cross_method_pi_already_succeeded',
      }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(502);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('processor_unavailable');
    expect(res.headers.get('Retry-After')).toBeNull();
  });

  it('502 processor_unavailable — error envelope MUST NOT leak the gateway `reason` (PCI / forbidden-fields hygiene)', async () => {
    // The route maps gateway errors to a static i18n message; the
    // raw `reason` (which originates from Stripe SDK error.message
    // and may carry account ids / key prefixes / forbidden detail)
    // must NEVER reach the client response body. Pin this so a
    // future regression that re-introduces `processorReason` into
    // the envelope is caught immediately.
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(
      err({
        code: 'processor_unavailable',
        kind: 'permanent',
        reason: 'sk_live_FORBIDDEN_DETAIL_THAT_MUST_NOT_LEAK',
      }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    const bodyText = await res.text();
    expect(bodyText).not.toContain('sk_live_FORBIDDEN_DETAIL_THAT_MUST_NOT_LEAK');
    expect(bodyText).not.toContain('processorReason');
    expect(bodyText).not.toContain('FORBIDDEN_DETAIL');
  });

  // Senior-tester F4 (Group B deferred, 2026-04-24): the standard error
  // envelope defined in contracts/payments-api.md MUST include a
  // `messageThai` field on every error response so Thai members receive
  // a localised message without the portal round-tripping. Pin this on
  // at least one representative 4xx so regressions can't silently drop
  // the field from the envelope.
  it('error responses carry a messageThai field (i18n contract)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(err({ code: 'invoice_not_payable' }));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['messageThai']).toBeDefined();
    expect(typeof error['messageThai']).toBe('string');
  });

  it('every response carries Cache-Control: no-store, private', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(err({ code: 'invoice_not_found' }));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    const cc = res.headers.get('Cache-Control');
    expect(cc).toContain('no-store');
    expect(cc).toContain('private');
  });

  it('every response carries X-Correlation-Id header', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce(err({ code: 'invoice_not_found' }));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.headers.get('X-Correlation-Id')).not.toBeNull();
  });

  it('403 forbidden_role — non-member session is rejected before use-case', async () => {
    requireMemberContextMock.mockRejectedValueOnce(
      Object.assign(new Error('forbidden_role'), { code: 'forbidden_role' }),
    );

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('forbidden_role');
  });

  // PCI F-02 / Threat OQ-1 (Group F Review-Gate fix): cross-tenant
  // `forbidden_invoice` returns the SAME opaque 403 +
  // `invoice_not_accessible` as `invoice_not_found` so a client cannot
  // distinguish cross-tenant existence from absolute absence. The use-
  // case retains the distinct cross-tenant audit emission.
  it('403 invoice_not_accessible — use-case returns forbidden_invoice (collapsed)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    initiatePaymentMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'forbidden_invoice' },
    });

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('invoice_not_accessible');
  });

  // Senior-tester F3 (MEDIUM) — unknown exception MUST map to 500
  // internal_error with a correlationId + generic message (no stack trace,
  // no internal error string per contracts/payments-api.md § 1).
  it('500 internal_error — unexpected use-case throw is caught + logged', async () => {
    initiatePaymentMock.mockRejectedValueOnce(new Error('db connection lost'));

    const { POST } = await importRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeJsonRequest(VALID_BODY));
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    const error = body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('internal_error');
    // Raw error message MUST NOT be surfaced
    expect(JSON.stringify(body)).not.toContain('db connection lost');
  });
});
