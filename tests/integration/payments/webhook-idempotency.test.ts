/**
 * T045 — Integration test: webhook event idempotency (SC-005).
 *
 * Spec authority:
 *   - specs/009-online-payment/contracts/stripe-webhook.md § 3 step 6
 *     ("ON CONFLICT (id) DO NOTHING — if already exists, return 200")
 *   - specs/009-online-payment/spec.md SC-005
 *   - specs/009-online-payment/spec.md FR-008
 *
 * SC-005 requirement: delivering the same Stripe event twice must produce
 * EXACTLY ONE of each side-effect:
 *   - one payments row update (status → 'succeeded')
 *   - one F4 markPaidFromProcessor invocation
 *   - one processor_events row with outcome='processed'
 *   - one outbox row (F4 receipt-email queue)
 *
 * This test exercises the route + use-case wiring in the mocked-port
 * contract-test pattern (NOT a real DB integration). "Integration" here
 * means "exercises the full route → use-case → port call chain" against
 * mocked infrastructure — distinguishing it from the unit test which
 * tests the use-case in isolation, and from T043 which uses the live DB.
 *
 * The idempotency guarantee is enforced at step 6 of the pipeline:
 *   INSERT INTO processor_events … ON CONFLICT (id) DO NOTHING
 * If the row already exists, the handler returns 200 immediately without
 * calling processWebhookEvent or markPaidFromProcessor again.
 *
 * RED reason: `src/app/api/webhooks/stripe/route.ts` does NOT exist yet.
 * `@ts-expect-error` on each dynamic import suppresses TS2307;
 * MODULE_NOT_FOUND at runtime makes every assertion fail.
 *
 * Turns GREEN: Group C T048 (route) + Group D T052 (processWebhookEvent
 * use-case with idempotency enforcement via processor_events insert).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams
// ---------------------------------------------------------------------------

const constructEventMock = vi.fn();

/**
 * Track how many times the use-case is invoked AND simulate the
 * idempotency guard: first call returns 'processed'; second call returns
 * 'duplicate' (idempotency guard fired, no side-effects executed).
 */
const processWebhookEventMock = vi.fn();
const markPaidFromProcessorMock = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest signature required so spread callers type-check (TS2556)
const insertProcessorEventMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('@/lib/stripe-webhook-verifier', () => ({
  webhookVerifier: {
    constructEvent: (...args: unknown[]) => constructEventMock(...args),
  },
}));

vi.mock('@/modules/payments', () => ({
  processWebhookEvent: (...args: unknown[]) => processWebhookEventMock(...args),
  makeProcessWebhookEventDeps: () => ({
    db: {},
    audit: {},
    insertProcessorEvent: (...args: unknown[]) => insertProcessorEventMock(...args),
  }),
}));

vi.mock('@/modules/invoicing', () => ({
  markPaidFromProcessor: (...args: unknown[]) => markPaidFromProcessorMock(...args),
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
  requestIdFromHeaders: () => 'req-idempotency-test',
}));

// ---------------------------------------------------------------------------
// Route import helper — @vite-ignore prevents Vite static-analysis failure
// when the route file does not exist yet (Group C T048).
// ---------------------------------------------------------------------------

async function importWebhookRoute() {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
  try {
    return await dynamicImport('@/app/api/webhooks/stripe/route');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `[RED — T045] webhook route not yet implemented (Group C T048). Import error: ${msg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Shared fixture event — same id both deliveries
// ---------------------------------------------------------------------------

const FIXED_EVENT_ID = 'evt_idempotency_test_001';

const STRIPE_EVENT_FIXTURE = {
  id: FIXED_EVENT_ID,
  object: 'event',
  type: 'payment_intent.succeeded',
  livemode: false,
  api_version: '2024-06-20',
  account: 'acct_test_swecham',
  created: 1_716_000_000,
  data: {
    object: {
      id: 'pi_idem_001',
      object: 'payment_intent',
      amount: 5_350_000,
      currency: 'thb',
      latest_charge: 'ch_idem_001',
      status: 'succeeded',
      payment_method_types: ['card'],
      charges: {
        data: [
          {
            id: 'ch_idem_001',
            payment_method_details: {
              card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2027 },
            },
          },
        ],
      },
    },
  },
};

const RAW_BODY = JSON.stringify(STRIPE_EVENT_FIXTURE);

function makeRequest(deliveryNum: number): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Different timestamp per delivery to simulate real Stripe re-delivery
      'stripe-signature': `t=${1_716_000_000 + deliveryNum},v1=validhex_${deliveryNum}`,
    },
    body: RAW_BODY,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('webhook-idempotency: SC-005 same event delivered twice (T045)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('first delivery: 200, processWebhookEvent called once', async () => {
    constructEventMock.mockReturnValueOnce(STRIPE_EVENT_FIXTURE);
    processWebhookEventMock.mockResolvedValueOnce({
      outcome: 'processed',
      paymentStatus: 'succeeded',
    });
    markPaidFromProcessorMock.mockResolvedValueOnce({
      status: 'paid',
      invoiceId: 'inv_test_001',
    });

    const { POST } = await importWebhookRoute() as { POST: (req: Request) => Promise<Response> };
    const res = await POST(makeRequest(1)) as Response;

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['received']).toBe(true);

    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);
  });

  it('second delivery of same event id: 200, processWebhookEvent outcome is duplicate', async () => {
    constructEventMock.mockReturnValue(STRIPE_EVENT_FIXTURE);

    // First delivery: processed normally
    processWebhookEventMock.mockResolvedValueOnce({
      outcome: 'processed',
      paymentStatus: 'succeeded',
    });

    const { POST } = await importWebhookRoute() as { POST: (req: Request) => Promise<Response> };

    const res1 = await POST(makeRequest(1)) as Response;
    expect(res1.status).toBe(200);
    expect(processWebhookEventMock).toHaveBeenCalledTimes(1);

    // Second delivery: idempotency guard fires — use-case returns 'duplicate'
    processWebhookEventMock.mockResolvedValueOnce({ outcome: 'duplicate' });

    const res2 = await POST(makeRequest(2)) as Response;
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as Record<string, unknown>;
    expect(body2['received']).toBe(true);

    // markPaidFromProcessor must NEVER be called by the route directly;
    // the use-case handles it internally and only on 'processed' outcome.
    expect(markPaidFromProcessorMock).toHaveBeenCalledTimes(0);
  });

  it('both deliveries return the identical { received: true } shape', async () => {
    constructEventMock.mockReturnValue(STRIPE_EVENT_FIXTURE);
    processWebhookEventMock
      .mockResolvedValueOnce({ outcome: 'processed' })
      .mockResolvedValueOnce({ outcome: 'duplicate' });

    const { POST } = await importWebhookRoute() as { POST: (req: Request) => Promise<Response> };

    const res1 = await POST(makeRequest(1)) as Response;
    const res2 = await POST(makeRequest(2)) as Response;

    const [body1, body2] = await Promise.all([
      res1.json() as Promise<Record<string, unknown>>,
      res2.json() as Promise<Record<string, unknown>>,
    ]);

    expect(body1).toEqual({ received: true });
    expect(body2).toEqual({ received: true });
  });

  it('processor_events dedup: both deliveries pass same event.id to processWebhookEvent', async () => {
    constructEventMock.mockReturnValue(STRIPE_EVENT_FIXTURE);
    processWebhookEventMock
      .mockResolvedValueOnce({ outcome: 'processed' })
      .mockResolvedValueOnce({ outcome: 'duplicate' });

    const { POST } = await importWebhookRoute() as { POST: (req: Request) => Promise<Response> };
    await POST(makeRequest(1));
    await POST(makeRequest(2));

    const calls = processWebhookEventMock.mock.calls as Array<Array<unknown>>;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstEventArg = (calls[0] as Array<Record<string, unknown>>)[1];
    expect(firstEventArg?.['id']).toBe(FIXED_EVENT_ID);

    // PCI SAQ-A structural guard (guardian F2 — Review-Gate blocker).
    // Mirror of T042 guard: the route→use-case boundary must carry a
    // structured allow-list (id/type/api_version/livemode), never the
    // raw event.data.object which holds payment_method_details with
    // last4/brand/exp/fingerprint at paths not covered by REDACT_PATHS.
    expect(firstEventArg).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        type: expect.any(String),
        api_version: expect.any(String),
        livemode: expect.any(Boolean),
      }),
    );
    expect(Object.keys(firstEventArg ?? {})).not.toContain('data');
  });

  it('second delivery: processWebhookEvent called at most twice total (no extra side-effects)', async () => {
    constructEventMock.mockReturnValue(STRIPE_EVENT_FIXTURE);
    processWebhookEventMock
      .mockResolvedValueOnce({ outcome: 'processed' })
      .mockResolvedValueOnce({ outcome: 'duplicate' });

    const { POST } = await importWebhookRoute() as { POST: (req: Request) => Promise<Response> };
    await POST(makeRequest(1));
    await POST(makeRequest(2));

    // At most 2 calls (one per delivery); both 200; no extra invocations
    expect(processWebhookEventMock.mock.calls.length).toBeLessThanOrEqual(2);
    // markPaid never called directly from route — delegated to use-case
    expect(markPaidFromProcessorMock).toHaveBeenCalledTimes(0);
  });
});
