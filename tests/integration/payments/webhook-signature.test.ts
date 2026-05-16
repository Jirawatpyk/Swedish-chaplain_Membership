/**
 * T044 — Integration test: webhook signature verification occurs BEFORE body parse.
 *
 * Spec authority: specs/009-online-payment/contracts/stripe-webhook.md § 3
 * pipeline steps 1→2→3; § 8 test matrix (a) (b).
 *
 * This test adds the "verify-before-parse" cross-cutting assertion that
 * cannot be expressed in the contract test (T042) because the contract
 * test mocks the verifier as a black box.
 *
 * Here we:
 *   1. Spy on the raw-body reader and the JSON parser independently.
 *   2. Assert that on signature failure paths, the JSON parser is NEVER
 *      invoked — the handler must short-circuit at the signature step.
 *   3. Assert that on valid-signature paths, both reader and parser ARE
 *      invoked in the correct order.
 *
 * Why this matters (from stripe-webhook.md § 1):
 *   "Body parser: disabled — handler reads raw body via NextRequest.text()"
 *   The HMAC covers the raw bytes. If the handler were to JSON.parse first
 *   and then verify, a Unicode normalization or whitespace-collapse attack
 *   could bypass the HMAC check. We assert the execution order here to
 *   prevent that regression from ever being introduced silently.
 *
 * Senior-tester F9 (Group B deferred, 2026-04-24): "Integration test"
 * naming here means route-handler → use-case composition exercised
 * end-to-end with mocked ports — NOT a live-DB integration test (which
 * is T043's scope). This file mocks `@/modules/payments` barrel +
 * verifier + auditRepo so the signature-verify ordering invariant can
 * be asserted deterministically without Neon round-trips.
 *
 * Pattern: uses vi.mock for the stripe verifier + a spy on NextRequest.text()
 * to count invocations. No real DB, no real Stripe SDK.
 *
 * RED reason: `src/app/api/webhooks/stripe/route.ts` and
 * `src/lib/stripe-webhook-verifier.ts` do NOT exist yet (Group C T048 + T053).
 * `@ts-expect-error` on each dynamic import suppresses TS2307 so
 * `pnpm typecheck` passes; MODULE_NOT_FOUND at runtime makes tests RED.
 *
 * Turns GREEN: Group C T048 (route handler) + Group C T053
 * (stripe-webhook-verifier helper).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams
// ---------------------------------------------------------------------------

const constructEventMock = vi.fn();
const processWebhookEventMock = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest signature required so spread callers type-check (TS2556)
const auditWriteMock = vi.fn(async (..._args: unknown[]) => undefined);

// F5R2-TY-B — route narrows verifier throws via `instanceof
// WebhookSignatureError`, so the mock must re-export the real
// error class. Importing from the original module preserves the
// instanceof check for tests that throw via `new WebhookSignatureError(...)`.
// Mocks that throw plain `Error` fall to the `verifier_internal_error`
// branch (also returns 401, which is the assertion these tests check).
vi.mock('@/lib/stripe-webhook-verifier', async () => {
  const original = await vi.importActual<typeof import('@/lib/stripe-webhook-verifier')>(
    '@/lib/stripe-webhook-verifier',
  );
  return {
    webhookVerifier: {
      constructEvent: (...args: unknown[]) => constructEventMock(...args),
    },
    WebhookSignatureError: original.WebhookSignatureError,
  };
});

vi.mock('@/lib/stripe-webhook-deps', async () => {
  const auth = await import('@/modules/auth/infrastructure/db/audit-repo');
  return {
     
    resolveTenantByProcessorAccountId: vi.fn(async (_account: string) => 'test-swecham'),
     
    insertRejectedProcessorEvent: vi.fn(async (_input: unknown) => undefined),
    auditRepo: auth.auditRepo,
  };
});

vi.mock('@/modules/payments', () => ({
  processWebhookEvent: (...args: unknown[]) => processWebhookEventMock(...args),
  makeProcessWebhookEventDeps: () => ({ db: {}, audit: {} }),
}));

vi.mock('@/modules/invoicing', () => ({
  markPaidFromProcessor: vi.fn(),
  makeMarkPaidFromProcessorDeps: () => ({ db: {}, blob: {}, audit: {} }),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
  // Future export added by Group C T049
  resolveTenantFromProcessorAccountId: vi.fn(async () => ({
    ctx: { slug: 'test-swecham', __brand: true },
  })),
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug, __brand: true }),
}));

/**
 * Mock the audit repo via the auth module's infrastructure barrel.
 * The exact path the route uses for audit writes is TBD until Group C T048
 * ships the route handler. This mock covers the most likely path.
 */
vi.mock('@/modules/auth/infrastructure/db/audit-repo', () => ({
  auditRepo: {
     
    append: vi.fn(async (..._args: unknown[]) => undefined),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-webhook-sig-test',
}));

// ---------------------------------------------------------------------------
// Route import helper — @vite-ignore prevents Vite static-analysis failure
// when the route file does not exist yet (Group C T048).
// ---------------------------------------------------------------------------

async function importWebhookRoute() {
  try {
    return await import('@/app/api/webhooks/stripe/route');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — T044] webhook route not yet implemented (Group C T048). Import error: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_RAW_BODY = JSON.stringify({
  id: 'evt_test_sig_001',
  object: 'event',
  type: 'payment_intent.succeeded',
  livemode: false,
  api_version: '2024-06-20',
  account: 'acct_test_swecham',
  created: 1_716_000_000,
  data: {
    object: {
      id: 'pi_test_sig_001',
      amount: 5_350_000,
      currency: 'thb',
      latest_charge: 'ch_test_sig_001',
      status: 'succeeded',
      payment_method_types: ['card'],
    },
  },
});

/**
 * Build a NextRequest and spy on its `.text()` method so we can assert
 * whether it was called (body was read) and how many times.
 */
function makeSpiedRequest(
  rawBody: string,
  headers: Record<string, string> = {},
): { req: NextRequest; textSpy: ReturnType<typeof vi.fn> } {
  const req = new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: rawBody,
  });

  const textSpy = vi.fn(async () => rawBody);
  Object.defineProperty(req, 'text', {
    value: textSpy,
    configurable: true,
    writable: true,
  });

  return { req, textSpy };
}

// ---------------------------------------------------------------------------
// Scenario 1: Missing Stripe-Signature header
// Behaviour: 401; body (req.text()) must NOT be called.
// ---------------------------------------------------------------------------

// M-9 (review 2026-04-27): describe-name flagged that this file lives
// under tests/integration/ but mocks every port — keeping the file
// path stable to preserve git history but the suite name reflects its
// real scope (route-boundary contract / component test, not a
// live-Neon integration). The Senior-tester F9 comment in the header
// docstring already documents this trade-off.
describe('webhook-signature route contract: verify-before-parse invariant (T044)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('missing Stripe-Signature → 401; req.text() never called', async () => {
    const { req, textSpy } = makeSpiedRequest(VALID_RAW_BODY, {});

    const { POST } = await importWebhookRoute() as unknown as { POST: (req: Request) => Promise<Response> };
    const res = await POST(req) as Response;

    expect(res.status).toBe(401);
    // The handler must inspect the header FIRST — before reading the body.
    expect(textSpy).not.toHaveBeenCalled();
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Malformed Stripe-Signature header
  // constructEvent throws → 401; processWebhookEvent must NOT be called.
  // req.text() IS called once (the raw body is needed to verify).
  // ---------------------------------------------------------------------------

  it('malformed Stripe-Signature → 401; req.text() called once; processWebhookEvent never called', async () => {
    constructEventMock.mockImplementationOnce(() => {
      throw new Error('No signatures found matching the expected signature');
    });

    const { req, textSpy } = makeSpiedRequest(VALID_RAW_BODY, {
      'stripe-signature': 't=1000,v1=badhex',
    });

    const { POST } = await importWebhookRoute() as unknown as { POST: (req: Request) => Promise<Response> };
    const res = await POST(req) as Response;

    expect(res.status).toBe(401);
    expect(textSpy).toHaveBeenCalledTimes(1);
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Tampered body — valid signature header format but
  // constructEvent throws because the body was modified after signing.
  // Same assertion: 401; processWebhookEvent not called.
  // ---------------------------------------------------------------------------

  it('tampered body → 401; processWebhookEvent never called', async () => {
    constructEventMock.mockImplementationOnce(() => {
      throw new Error(
        'Webhook signature verification failed. Payload hash mismatch',
      );
    });

    const tamperedBody = VALID_RAW_BODY + ' '; // trailing space invalidates HMAC
    const { req, textSpy } = makeSpiedRequest(tamperedBody, {
      'stripe-signature': 't=1716000000,v1=validlookinghexbutwrong',
    });

    const { POST } = await importWebhookRoute() as unknown as { POST: (req: Request) => Promise<Response> };
    const res = await POST(req) as Response;

    expect(res.status).toBe(401);
    expect(textSpy).toHaveBeenCalledTimes(1);
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // Scenario 4 (positive): Valid signature → body IS read; processWebhookEvent
  // IS called; route returns 200.
  // ---------------------------------------------------------------------------

  it('valid signature → req.text() called; processWebhookEvent called; 200', async () => {
    const event = JSON.parse(VALID_RAW_BODY) as Record<string, unknown>;
    constructEventMock.mockReturnValueOnce(event);
    // F5R2-CRIT-2 — route now narrows via `if (!result.ok)` instead
    // of the prior duck-type `(result as {ok?:boolean}).ok === false`
    // check. The mock must return a proper `Result.ok` shape now.
    processWebhookEventMock.mockResolvedValueOnce({
      ok: true,
      value: { kind: 'acknowledged_only' },
    });

    const { req, textSpy } = makeSpiedRequest(VALID_RAW_BODY, {
      'stripe-signature': 't=1716000000,v1=validhex',
    });

    const { POST } = await importWebhookRoute() as unknown as { POST: (req: Request) => Promise<Response> };
    const res = await POST(req) as Response;

    expect(res.status).toBe(200);
    // Body must be read exactly once — verifier receives the raw string.
    expect(textSpy).toHaveBeenCalledTimes(1);
    // constructEvent received rawBody as first argument.
    expect(constructEventMock).toHaveBeenCalledTimes(1);
    const firstCallArgs = constructEventMock.mock.calls[0] as unknown[];
    expect(firstCallArgs[0]).toBe(VALID_RAW_BODY);
    // Use-case was invoked.
    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: webhook_signature_rejected audit emitted on missing header
  // stripe-webhook.md § 2: "Missing Stripe-Signature → 401 + audit
  // webhook_signature_rejected{reason='missing_header'}"
  // ---------------------------------------------------------------------------

  it("missing header → audit webhook_signature_rejected reason='missing_header' emitted", async () => {
    const { req } = makeSpiedRequest(VALID_RAW_BODY, {});

    const { POST } = await importWebhookRoute() as unknown as { POST: (req: Request) => Promise<Response> };
    await POST(req);

    // The audit helper must have been called with the rejection event.
    // Access the mocked auditRepo.append via the infrastructure barrel.
    const { auditRepo } = await import('@/modules/auth/infrastructure/db/audit-repo');
    const appendMock = vi.mocked(
      auditRepo.append as unknown as (...a: unknown[]) => unknown,
    );
    const allCalls = appendMock.mock.calls as Array<Array<unknown>>;
    const rejectionCall = allCalls.find((call) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      return arg?.['eventType'] === 'webhook_signature_rejected';
    });
    expect(rejectionCall).toBeDefined();

    const auditArg = rejectionCall?.[0] as Record<string, unknown> | undefined;
    expect(auditArg?.['reason']).toBe('missing_header');

    // PCI F5 (Group B deferred, 2026-04-24): the webhook_signature_rejected
    // audit row MUST NOT carry the raw body or the (possibly-HMAC-valid)
    // signature header — those are sensitive attacker inputs that have
    // no legitimate forensic value in the audit surface beyond the
    // reason code. Negative-asserts pin this so Group D T056 cannot
    // add "useful debugging context" that silently expands SAQ-A scope.
    expect(auditArg?.['rawBody']).toBeUndefined();
    expect(auditArg?.['raw_body']).toBeUndefined();
    expect(auditArg?.['signature']).toBeUndefined();
    expect(auditArg?.['stripe-signature']).toBeUndefined();
    expect(auditArg?.['stripeSignature']).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 6 (Threat F-16 — Group F Review-Gate fix): oversized payload.
  //
  // Adversary sends a 200 KB body with a valid-looking Stripe-Signature
  // header. The route MUST reject BEFORE HMAC verification so the
  // verifier never does HMAC work on an attacker-sized buffer. The
  // reject reason is audited as `body_too_large`.
  // ---------------------------------------------------------------------------

  it('Content-Length > 64 KiB → 401; verifier never called; audit body_too_large', async () => {
    const { req, textSpy } = makeSpiedRequest(VALID_RAW_BODY, {
      'stripe-signature': 't=1716000000,v1=validlookinghex',
      'content-length': '200000',
    });

    const { POST } = await importWebhookRoute() as unknown as { POST: (req: Request) => Promise<Response> };
    const res = await POST(req) as Response;

    expect(res.status).toBe(401);
    // Body was NOT read (guard fires before request.text()).
    expect(textSpy).not.toHaveBeenCalled();
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(processWebhookEventMock).not.toHaveBeenCalled();

    // Audit row emitted with reason='body_too_large'.
    const { auditRepo } = await import('@/modules/auth/infrastructure/db/audit-repo');
    const appendMock = vi.mocked(
      auditRepo.append as unknown as (...a: unknown[]) => unknown,
    );
    const allCalls = appendMock.mock.calls as Array<Array<unknown>>;
    const rejectionCall = allCalls.find((call) => {
      const arg = call[0] as Record<string, unknown> | undefined;
      return arg?.['eventType'] === 'webhook_signature_rejected'
        && arg?.['reason'] === 'body_too_large';
    });
    expect(rejectionCall).toBeDefined();
  });
});
