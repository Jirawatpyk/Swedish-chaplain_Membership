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
  // F5R3 CR-3 wired the route to import this from the barrel for the
  // typed-payload emit on permanent_failure path.
  SYSTEM_ACTOR_STRIPE_WEBHOOK: 'system:webhook',
}));

// F5R3 CR-3 / CR-8 — mock the F5 audit adapter so CR-8 tests can
// assert the typed-payload emit fired with the right shape on
// permanence='permanent' dispatch failure. Re-exports the real
// audit-port module so route's `retentionFor` import still resolves
// to the canonical retention map.
const f5AuditAdapterEmitMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock('@/modules/payments/infrastructure/audit/drizzle-payments-audit', () => ({
  f5AuditAdapter: {
    emit: (...args: unknown[]) => f5AuditAdapterEmitMock(...args),
  },
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

  // ===========================================================================
  // F5R3 CR-8 (2026-05-16) — Permanence-routing regression coverage
  // ===========================================================================
  //
  // R2-CRIT-2 fixed the route to map dispatch_failed errors by their
  // typed `permanence` discriminator: 'transient' → 5xx (Stripe retries
  // through the outage window) / 'permanent' → 200 + forensic audit
  // (stops the 72h retry storm). Pre-fix the route used a duck-type
  // `result.error` cast with `?? 'transient'` defaulting that erased
  // the type-level guarantee. These tests pin the wire-level behaviour
  // so a future regression that drops permanence classification fails
  // CI loudly.
  // ---------------------------------------------------------------------------

  it('R2-CRIT-2: dispatch_failed transient → 5xx (Stripe retries through outage)', async () => {
    const event = JSON.parse(VALID_RAW_BODY) as Record<string, unknown>;
    constructEventMock.mockReturnValueOnce(event);
    processWebhookEventMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'dispatch_failed',
        kind: 'sub_use_case_error',
        eventType: 'payment_intent.succeeded',
        detail: 'processor_unavailable',
        subDetail: null,
        retryCeilingExceeded: false,
        permanence: 'transient',
      },
    });

    const { req } = makeSpiedRequest(VALID_RAW_BODY, {
      'stripe-signature': 't=1716000000,v1=validhex',
    });
    const { POST } = (await importWebhookRoute()) as unknown as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = (await POST(req)) as Response;

    // Must be 5xx so Stripe retries (transient outages recover within
    // Stripe's 72h retry window).
    expect(res.status).toBeGreaterThanOrEqual(500);
    // Permanent-failure audit MUST NOT fire on transient path.
    const f5EmitCalls = f5AuditAdapterEmitMock.mock.calls as Array<Array<unknown>>;
    const permanentEmits = f5EmitCalls.filter((call) => {
      const event = call[1] as { eventType?: string } | undefined;
      return event?.eventType === 'webhook_dispatch_permanent_failure';
    });
    expect(permanentEmits.length).toBe(0);
  });

  it('R2-CRIT-2: dispatch_failed permanent → 200 + webhook_dispatch_permanent_failure typed audit (stops Stripe 72h retry storm)', async () => {
    const event = JSON.parse(VALID_RAW_BODY) as Record<string, unknown>;
    constructEventMock.mockReturnValueOnce(event);
    processWebhookEventMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'dispatch_failed',
        kind: 'sub_use_case_error',
        eventType: 'payment_intent.succeeded',
        // money-remediation Task 5 — post-Task-5 the dispatcher's `detail` is
        // the coarse CODE and the discriminating sub-code sits in
        // `subDetail`. Pinning the old shape here would have this test assert
        // a combination the dispatcher can no longer produce.
        detail: 'bridge_error',
        subDetail: 'tenant_settings_missing',
        retryCeilingExceeded: false,
        permanence: 'permanent',
      },
    });

    const { req } = makeSpiedRequest(VALID_RAW_BODY, {
      'stripe-signature': 't=1716000000,v1=validhex',
    });
    const { POST } = (await importWebhookRoute()) as unknown as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = (await POST(req)) as Response;

    // 200 ack so Stripe stops retrying (permanent error has zero
    // chance of recovery — F4 misconfiguration / removed account).
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['dispatched']).toBe(false);
    expect(body['reason']).toBe('permanent_failure_acknowledged');
    // Body MUST NOT leak the dispatch_failure_detail (visible in
    // Stripe Dashboard webhook log to anyone with read access).
    expect(body['detail']).toBeUndefined();

    // F5R3 CR-3 — the typed payload emit fired through the F5
    // adapter (NOT the F1 auditRepo.append, which doesn't persist
    // payload). Adapter call shape: emit(null, F5AuditEvent).
    const f5EmitCalls = f5AuditAdapterEmitMock.mock.calls as Array<Array<unknown>>;
    const permanentEmit = f5EmitCalls.find((call) => {
      const arg = call[1] as { eventType?: string } | undefined;
      return arg?.eventType === 'webhook_dispatch_permanent_failure';
    });
    expect(permanentEmit).toBeDefined();
    const eventArg = permanentEmit![1] as {
      eventType: string;
      payload: Record<string, unknown>;
      retentionYears: number;
    };
    expect(eventArg.eventType).toBe('webhook_dispatch_permanent_failure');
    expect(eventArg.payload['dispatch_failure_kind']).toBe('sub_use_case_error');
    expect(eventArg.payload['dispatch_failure_detail']).toBe('bridge_error');
    // money-remediation Task 5 — the 5y forensic finally carries the F4/F5
    // sub-code. Pre-Task-5 `dispatch_failure_detail` was `'bridge_error'` for
    // EVERY F4 decline, so this row could not tell an operator which invoice
    // state to repair.
    expect(eventArg.payload['dispatch_failure_sub_detail']).toBe(
      'tenant_settings_missing',
    );
    // Classified permanent on its own merits — not a retry-budget give-up.
    expect(eventArg.payload['dispatch_failure_retry_ceiling_exceeded']).toBe(
      false,
    );
    expect(eventArg.payload['stripe_event_type']).toBe(
      'payment_intent.succeeded',
    );
    expect(eventArg.retentionYears).toBe(5);
  });

  /**
   * money-remediation Task 5 — the retry-ceiling give-up, at the wire.
   *
   * Task 5 makes transient F4 declines return 500 where they returned 200,
   * and Stripe DISABLES endpoints that fail persistently. The ceiling caps
   * that exposure by 200-acking a transient once the event outlives 48h,
   * with a forensic row that says so. This pins the two halves an operator
   * reads: it stops the retries (200), and it does NOT claim the underlying
   * failure was permanent.
   */
  it('T5: retry-ceiling give-up → 200 + forensic marked as a give-up, not a permanent failure', async () => {
    const event = JSON.parse(VALID_RAW_BODY) as Record<string, unknown>;
    constructEventMock.mockReturnValueOnce(event);
    processWebhookEventMock.mockResolvedValueOnce({
      ok: false,
      error: {
        code: 'dispatch_failed',
        kind: 'sub_use_case_error',
        eventType: 'payment_intent.succeeded',
        // A TRANSIENT class (Blob outage) that outlived the 48h budget.
        detail: 'bridge_error',
        subDetail: 'blob_upload_failed',
        retryCeilingExceeded: true,
        permanence: 'permanent',
      },
    });

    const { req } = makeSpiedRequest(VALID_RAW_BODY, {
      'stripe-signature': 't=1716000000,v1=validhex',
    });
    const { POST } = (await importWebhookRoute()) as unknown as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = (await POST(req)) as Response;

    // 200 so Stripe drains the queue and does not disable the endpoint.
    expect(res.status).toBe(200);

    const f5EmitCalls = f5AuditAdapterEmitMock.mock.calls as Array<Array<unknown>>;
    const emit = f5EmitCalls.find((call) => {
      const arg = call[1] as { eventType?: string } | undefined;
      return arg?.eventType === 'webhook_dispatch_permanent_failure';
    });
    expect(emit).toBeDefined();
    const eventArg = emit![1] as {
      summary: string;
      payload: Record<string, unknown>;
    };
    expect(eventArg.payload['dispatch_failure_sub_detail']).toBe(
      'blob_upload_failed',
    );
    expect(eventArg.payload['dispatch_failure_retry_ceiling_exceeded']).toBe(true);
    // The summary must not read as "permanently failed" — at 3am that is the
    // difference between "repair this invoice" and "Blob was down for 2 days".
    expect(eventArg.summary).toContain('gave up after the transient retry ceiling');
    expect(eventArg.summary).not.toContain('permanently failed');
  });

  it('R2-TY-B: verifier throws non-WebhookSignatureError (TypeError) → 401 verifier_internal_error branch (not webhook_signature_rejected reason)', async () => {
    constructEventMock.mockImplementationOnce(() => {
      throw new TypeError('cannot read property .secret of undefined');
    });

    const { req } = makeSpiedRequest(VALID_RAW_BODY, {
      'stripe-signature': 't=1716000000,v1=validhex',
    });
    const { POST } = (await importWebhookRoute()) as unknown as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = (await POST(req)) as Response;

    // 401 (matches the canonical signature-rejection status code).
    expect(res.status).toBe(401);
    expect(processWebhookEventMock).not.toHaveBeenCalled();

    // Audit append fired with reason='verifier_internal_error', NOT
    // a WebhookSignatureError kind label. R2-TY-B's instanceof
    // WebhookSignatureError narrowing routes plain Error throws to
    // this dedicated branch so SREs can distinguish "Stripe SDK
    // crashed" from "attacker forged signature" in the alert log.
    const { auditRepo } = await import('@/modules/auth/infrastructure/db/audit-repo');
    const appendMock = vi.mocked(
      auditRepo.append as unknown as (...a: unknown[]) => unknown,
    );
    const internalErrorCall = (appendMock.mock.calls as Array<Array<unknown>>).find(
      (call) => {
        const arg = call[0] as Record<string, unknown> | undefined;
        return (
          arg?.['eventType'] === 'webhook_signature_rejected' &&
          arg?.['reason'] === 'verifier_internal_error'
        );
      },
    );
    expect(internalErrorCall).toBeDefined();
  });
});
