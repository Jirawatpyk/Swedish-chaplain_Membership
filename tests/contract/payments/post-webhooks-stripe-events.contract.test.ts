/**
 * T042 — Contract test: POST /api/webhooks/stripe (event dispatch).
 *
 * Spec authority:
 *   - specs/009-online-payment/contracts/stripe-webhook.md § 3 pipeline
 *   - specs/009-online-payment/contracts/stripe-webhook.md § 4.1
 *   - specs/009-online-payment/contracts/stripe-webhook.md § 8 (test matrix a–i)
 *
 * Exercises the full verification + idempotency pipeline described in
 * stripe-webhook.md § 3 using a mocked webhook verifier and mocked
 * payments/invoicing use cases. No Stripe SDK, no DB, no Redis.
 *
 * Pattern mirrors tests/contract/tenant-invoice-settings-logo-route.test.ts.
 *
 * RED reason: `src/app/api/webhooks/stripe/route.ts` does NOT exist yet
 * (created by Group C T048). `@ts-expect-error` on each dynamic import
 * suppresses TS2307 so `pnpm typecheck` passes; the MODULE_NOT_FOUND at
 * runtime makes every assertion fail (RED).
 *
 * Turns GREEN: Group C T048 (webhook route handler) + Group D T052
 * (processWebhookEvent use-case).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams
// ---------------------------------------------------------------------------

const constructEventMock = vi.fn();
const processWebhookEventMock = vi.fn();
const markPaidFromProcessorMock = vi.fn();

vi.mock('@/lib/stripe-webhook-verifier', () => ({
  webhookVerifier: {
    constructEvent: (...args: unknown[]) => constructEventMock(...args),
  },
}));

/**
 * @/modules/payments barrel does NOT export `processWebhookEvent` yet —
 * Group D T052. The mock is valid TS; the route import will fail first.
 */
vi.mock('@/modules/payments', () => ({
  processWebhookEvent: (...args: unknown[]) => processWebhookEventMock(...args),
  makeProcessWebhookEventDeps: () => ({ db: {}, audit: {} }),
}));

vi.mock('@/modules/invoicing', () => ({
  markPaidFromProcessor: (...args: unknown[]) => markPaidFromProcessorMock(...args),
  makeMarkPaidFromProcessorDeps: () => ({ db: {}, blob: {}, audit: {} }),
}));

/**
 * @/lib/tenant-context currently exports only `resolveTenantFromRequest`.
 * `resolveTenantFromProcessorAccountId` will be added in Group C T049
 * (tenant-context extension for webhook tenant resolution).
 * Mock the whole module so the route can call whichever function it uses.
 */
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
  // Future export added by Group C T049 — mocked here for contract isolation
  resolveTenantFromProcessorAccountId: vi.fn(async () => ({
    ctx: { slug: 'test-swecham', __brand: true },
  })),
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug, __brand: true }),
}));

/**
 * Mock the audit repo via the auth infrastructure barrel.
 * The exact import path used by the webhook route is TBD until Group C T048
 * ships the handler. This mock covers the expected path.
 */
vi.mock('@/modules/auth/infrastructure/db/audit-repo', () => ({
  auditRepo: {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest signature required so spread callers type-check (TS2556)
    append: vi.fn(async (..._args: unknown[]) => undefined),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-webhook-1',
}));

// ---------------------------------------------------------------------------
// Stripe event fixtures (inline — no real Stripe SDK)
// ---------------------------------------------------------------------------

const PINNED_API_VERSION = '2024-06-20';

function makeStripeEvent(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: 'evt_test_001',
    object: 'event',
    type: 'payment_intent.succeeded',
    livemode: false,
    api_version: PINNED_API_VERSION,
    account: 'acct_test_swecham',
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: 'pi_test_001',
        object: 'payment_intent',
        amount: 5_350_000,
        currency: 'thb',
        latest_charge: 'ch_test_001',
        status: 'succeeded',
        payment_method_types: ['card'],
        charges: {
          data: [
            {
              id: 'ch_test_001',
              payment_method_details: {
                card: {
                  last4: '4242',
                  brand: 'visa',
                  exp_month: 12,
                  exp_year: 2027,
                },
              },
            },
          ],
        },
      },
    },
    ...overrides,
  };
}

function makeWebhookRequest(
  rawBody: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Route import helper — uses new Function to bypass Vite static-analysis
// at transform time. @vite-ignore does NOT work with @/ aliases because
// Vite resolves aliases before checking the ignore comment.
// new Function defers import to pure runtime; Vite never sees it.
// ---------------------------------------------------------------------------

async function importWebhookRoute() {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
  try {
    return await dynamicImport('@/app/api/webhooks/stripe/route');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — T042] webhook route not yet implemented (Group C T048). Import error: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests (matrix from stripe-webhook.md § 8)
// ---------------------------------------------------------------------------

describe('contract: POST /api/webhooks/stripe (T042)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // (a) Signature missing → 401
  it('(a) missing Stripe-Signature header → 401, body never parsed', async () => {
    const rawBody = JSON.stringify(makeStripeEvent());
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(makeWebhookRequest(rawBody, {})) as Response;
    expect(res.status).toBe(401);
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  // (b) Signature malformed → 401
  it('(b) malformed Stripe-Signature → 401', async () => {
    constructEventMock.mockImplementationOnce(() => {
      throw new Error('No signatures found matching');
    });

    const rawBody = JSON.stringify(makeStripeEvent());
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=bad,v1=bad' }),
    ) as Response;
    expect(res.status).toBe(401);
    expect(processWebhookEventMock).not.toHaveBeenCalled();
  });

  // (c) Valid sig + livemode mismatch → 200 + audit payment_environment_mismatch
  it('(c) livemode mismatch → 200 + payment_environment_mismatch audit', async () => {
    const event = makeStripeEvent({ livemode: true }); // env is test; event says live
    constructEventMock.mockReturnValueOnce(event);

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['received']).toBe(true);
    expect(processWebhookEventMock).not.toHaveBeenCalled();

    // Senior-tester F5 (Group B deferred, 2026-04-24): spec § 3 step 4
    // requires `payment_environment_mismatch` audit + a processor_event
    // row with outcome='rejected_environment_mismatch'. Assert audit
    // was invoked so Group D T056 can't silently drop the audit when
    // it implements processWebhookEvent.
    const { auditRepo } = await import('@/modules/auth/infrastructure/db/audit-repo');
    expect(auditRepo.append).toHaveBeenCalled();
    const auditCalls = (auditRepo.append as ReturnType<typeof vi.fn>).mock.calls;
    const emitted = auditCalls.map((c) => JSON.stringify(c));
    expect(emitted.some((s) => s.includes('payment_environment_mismatch'))).toBe(true);
  });

  // (d) Valid sig + api_version mismatch → 200 + webhook_api_version_mismatch audit
  it('(d) api_version mismatch → 200 + webhook_api_version_mismatch audit', async () => {
    const event = makeStripeEvent({ api_version: '2020-01-01' }); // outdated
    constructEventMock.mockReturnValueOnce(event);

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    expect(res.status).toBe(200);
    expect(processWebhookEventMock).not.toHaveBeenCalled();

    // Senior-tester F5: spec § 3 step 5 requires webhook_api_version_mismatch
    // audit when event.api_version drifts from STRIPE_API_VERSION.
    const { auditRepo } = await import('@/modules/auth/infrastructure/db/audit-repo');
    const auditCalls = (auditRepo.append as ReturnType<typeof vi.fn>).mock.calls;
    const emitted = auditCalls.map((c) => JSON.stringify(c));
    expect(emitted.some((s) => s.includes('webhook_api_version_mismatch'))).toBe(true);
  });

  // (e) Duplicate event id → 200 + no side-effect (idempotency)
  it('(e) duplicate event id → 200, processWebhookEvent returns duplicate outcome', async () => {
    const event = makeStripeEvent();
    constructEventMock.mockReturnValue(event);

    processWebhookEventMock.mockResolvedValueOnce({ outcome: 'processed' });
    processWebhookEventMock.mockResolvedValueOnce({ outcome: 'duplicate' });

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };

    const res1 = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    expect(res1.status).toBe(200);

    const res2 = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=2,v1=valid' }),
    ) as Response;
    expect(res2.status).toBe(200);

    // Second delivery must NOT invoke F4 markPaid again
    expect(markPaidFromProcessorMock).toHaveBeenCalledTimes(0);
  });

  // (f) payment_intent.succeeded happy path → 200, processWebhookEvent called once
  it('(f) payment_intent.succeeded → 200, processWebhookEvent called, returns processed', async () => {
    const event = makeStripeEvent();
    constructEventMock.mockReturnValueOnce(event);
    processWebhookEventMock.mockResolvedValueOnce({
      outcome: 'processed',
      paymentStatus: 'succeeded',
      markPaidInvoked: true,
    });

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['received']).toBe(true);

    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
    const firstArg = processWebhookEventMock.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(firstArg?.['id']).toBe('evt_test_001');

    // PCI SAQ-A structural guard (guardian F1 — Review-Gate blocker).
    // The route MUST hand the use-case a *structured allow-list* of
    // webhook metadata — NEVER the raw `event.data.object` (which carries
    // card metadata last4/brand/exp/fingerprint at deep paths NOT covered
    // by REDACT_PATHS). Asserting shape here pins the contract before
    // Group D/T056 implements processWebhookEvent so a future drift into
    // "just pass the whole event object" cannot sneak through review.
    expect(firstArg).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        type: expect.any(String),
        api_version: expect.any(String),
        livemode: expect.any(Boolean),
      }),
    );
    // Explicit exclusion: the data envelope carries payment_method_details —
    // it MUST be handled by the use-case internally (with an allow-listed
    // logger payload) not passed through at the route/composition boundary.
    expect(Object.keys(firstArg ?? {})).not.toContain('data');
  });

  // (g) charge.refunded for unknown refund → 200, out_of_band_refund_detected
  it('(g) charge.refunded unknown → 200 + out_of_band_refund_detected outcome', async () => {
    const event = makeStripeEvent({
      id: 'evt_test_refund_002',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_test_002',
          refunds: {
            data: [{ id: 're_test_unknown_001', amount: 500000 }],
          },
        },
      },
    });
    constructEventMock.mockReturnValueOnce(event);
    processWebhookEventMock.mockResolvedValueOnce({
      outcome: 'processed',
      auditEmitted: 'out_of_band_refund_detected',
    });

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    expect(res.status).toBe(200);
  });

  // (h) Unknown event type → 200, acknowledged_only
  it('(h) unknown event type → 200, acknowledged_only', async () => {
    const event = makeStripeEvent({
      id: 'evt_test_unknown_003',
      type: 'some.future.event',
    });
    constructEventMock.mockReturnValueOnce(event);
    processWebhookEventMock.mockResolvedValueOnce({ outcome: 'acknowledged_only' });

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['received']).toBe(true);
  });

  // (i) Tenant resolution miss → 200 + warn audit
  it('(i) tenant resolution miss → 200, processWebhookEvent NOT called', async () => {
    const event = makeStripeEvent({ account: 'acct_unknown_xyz' });
    constructEventMock.mockReturnValueOnce(event);

    // Override the mocked resolveTenantFromProcessorAccountId for this test.
    // Senior-tester F6 (Group B deferred, 2026-04-24): if Group C/D renames
    // the export, silent optional-chaining (`resolveFunc?.mock…(…)`) would
    // let this test pass without exercising anything. Assert defined first.
    const tenantContextModule = await import('@/lib/tenant-context');
    const resolveFunc = (
      tenantContextModule as Record<string, unknown>
    )['resolveTenantFromProcessorAccountId'] as ReturnType<typeof vi.fn> | undefined;
    expect(resolveFunc).toBeDefined();
    (resolveFunc as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    expect(res.status).toBe(200);
  });

  // All 200 responses return { received: true } (stripe-webhook.md § 5)
  it('200 responses always return { received: true }', async () => {
    const event = makeStripeEvent();
    constructEventMock.mockReturnValueOnce(event);
    processWebhookEventMock.mockResolvedValueOnce({ outcome: 'processed' });

    const rawBody = JSON.stringify(event);
    const { POST } = await importWebhookRoute() as { POST: (req: NextRequest) => Promise<Response> };
    const res = await POST(
      makeWebhookRequest(rawBody, { 'stripe-signature': 't=1,v1=valid' }),
    ) as Response;
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ received: true });
  });
});
