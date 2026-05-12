/**
 * T036 — Contract test: POST /api/webhooks/eventcreate/v1/[tenantSlug]
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/contracts/webhook-eventcreate-api.md § Responses
 *   - FR-001..FR-013, FR-037
 *
 * Exercises every HTTP outcome category (200/401/409/400/415/429/503/5xx)
 * with the dependencies mocked at module-boundary so no DB, no Upstash,
 * no actual HMAC verify infrastructure is hit. Pattern mirrors
 * tests/contract/payments/post-webhooks-stripe-events.contract.test.ts.
 *
 * RED reason: `src/app/api/webhooks/eventcreate/v1/[tenantSlug]/route.ts`
 * does NOT exist yet (created by T052). The dynamic import will throw
 * MODULE_NOT_FOUND making every test FAIL.
 *
 * Turns GREEN: T052 route handler + T043/T047 use-cases land.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signWebhookBody, makeWebhookPayload } from '../../integration/events/helpers/sign-webhook';

// ---------------------------------------------------------------------------
// Mock seams — replace heavy dependencies at module boundary.
// ---------------------------------------------------------------------------

const ingestWebhookAttendeeMock = vi.fn();
const verifyWebhookSignatureMock = vi.fn();
const auditEmitMock = vi.fn();
const auditEmitRolledBackMock = vi.fn();
const ratelimitCheckMock = vi.fn();

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>('@/modules/events');
  return {
    ...actual,
    // Use-case exports (added per Phase 3 T043/T047 — mock until then).
    ingestWebhookAttendee: (...args: unknown[]) => ingestWebhookAttendeeMock(...args),
    verifyWebhookSignature: (...args: unknown[]) => verifyWebhookSignatureMock(...args),
  };
});

vi.mock('@/lib/events-webhook-deps', () => ({
  // Route-level composition adapter; assembled by T052 alongside the
  // route. Returns the wired audit-port, repos, idempotency-store, etc.
  makeIngestWebhookAttendeeDeps: () => ({
    audit: {
      emit: (...args: unknown[]) => auditEmitMock(...args),
      emitRolledBack: (...args: unknown[]) => auditEmitRolledBackMock(...args),
    },
  }),
  ratelimitCheck: (...args: unknown[]) => ratelimitCheckMock(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const TEST_SECRET = 'test-secret-32-bytes-base64url-encoded-aaa';
const TENANT_SLUG = 'test-swecham';
const ROUTE_PATH = `/api/webhooks/eventcreate/v1/${TENANT_SLUG}`;

async function loadRoute() {
  // Dynamic import — route handler created by T052 (Phase 3 GREEN).
  // Until then, Vite's static-analysis alias transform fails to resolve
  // the import at suite-load time with `Failed to resolve import "@/app/
  // api/webhooks/eventcreate/v1/[tenantSlug]/route"`. That suite-load
  // failure IS the [RED — T036] marker — the test framework reports the
  // failure cleanly with a pointer to the missing module. Project memory
  // suggested a `new Function('m','return import(m)')` bypass to defer
  // resolution past Vite, but the runtime configuration on this branch
  // surfaces `TypeError: dynamic import callback was not specified`
  // because Vitest's module loader does not register a HostImport
  // callback for `new Function`-emitted eval contexts. Plain `import()`
  // gives the cleaner RED signal.
  try {
    return (await import(
      // @ts-expect-error — module does not exist until T052 (RED phase marker)
      '@/app/api/webhooks/eventcreate/v1/[tenantSlug]/route'
    )) as {
      POST: (req: NextRequest, ctx: { params: Promise<{ tenantSlug: string }> }) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[RED — T036] route not yet implemented (T052). Import error: ${msg}`);
  }
}

function buildRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  const signed = signWebhookBody({ body, secret: TEST_SECRET });
  return new NextRequest(`https://app.test${ROUTE_PATH}`, {
    method: 'POST',
    body: signed.rawBody,
    headers: {
      'Content-Type': 'application/json',
      'X-Chamber-Signature': signed.signatureHeader,
      'X-Chamber-Timestamp': signed.timestamp,
      'X-Request-ID': 'req-test-001',
      ...headers,
    },
  });
}

describe('T036 — F6 webhook receiver contract (HTTP outcome matrix)', () => {
  it('200 OK — success commits ingest tx + returns matched + registrationId', async () => {
    const { POST } = await loadRoute();
    ingestWebhookAttendeeMock.mockResolvedValue({
      ok: true,
      value: {
        matched: 'member_contact',
        matchedMemberId: '01H1ABC',
        eventCreated: true,
        registrationId: '01H2DEF',
        quotaEffect: { countedAgainstPartnership: false, countedAgainstCulturalQuota: false },
      },
    });
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.matched).toBe('member_contact');
    expect(body.registrationId).toBe('01H2DEF');
  });

  it('401 Unauthorized — signature reject returns generic body (no oracle)', async () => {
    const { POST } = await loadRoute();
    const req = buildRequest(makeWebhookPayload(), {
      'X-Chamber-Signature': 'sha256=00deadbeef', // bad signature
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.title).toBe('Webhook authentication failed');
    // No discriminator leak — body does NOT reveal which check failed.
    expect(JSON.stringify(body)).not.toMatch(/signature_mismatch|skew|missing_header/i);
  });

  it('401 Unauthorized — timestamp skew >5min returns same generic 401 body', async () => {
    const { POST } = await loadRoute();
    const signed = signWebhookBody({
      body: makeWebhookPayload(),
      secret: TEST_SECRET,
      timestampSeconds: Math.floor(Date.now() / 1000) - 360, // 6 min ago
    });
    const req = new NextRequest(`https://app.test${ROUTE_PATH}`, {
      method: 'POST',
      body: signed.rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-Chamber-Signature': signed.signatureHeader,
        'X-Chamber-Timestamp': signed.timestamp,
        'X-Request-ID': 'req-skew-001',
      },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(401);
  });

  it('409 Conflict — duplicate X-Request-ID within 7d returns 409 with no side effects', async () => {
    const { POST } = await loadRoute();
    ingestWebhookAttendeeMock.mockResolvedValue({
      ok: false,
      error: { kind: 'duplicate_request_id', originalProcessedAt: new Date() },
    });
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.status).toBe(409);
    expect(body.requestId).toBeDefined();
  });

  it('400 Bad Request — malformed payload returns field-level errors', async () => {
    const { POST } = await loadRoute();
    const req = buildRequest({ eventType: 'attendee.registered' }); // missing event + attendee
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.errors).toBeInstanceOf(Array);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors[0]).toHaveProperty('path');
    expect(body.errors[0]).toHaveProperty('message');
  });

  it('415 Unsupported Media Type — non-JSON Content-Type returns 415', async () => {
    const { POST } = await loadRoute();
    const req = new NextRequest(`https://app.test${ROUTE_PATH}`, {
      method: 'POST',
      body: '<xml/>',
      headers: { 'Content-Type': 'application/xml' },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(415);
  });

  it('429 Too Many Requests — rate-limit exceeded returns Retry-After header', async () => {
    const { POST } = await loadRoute();
    ratelimitCheckMock.mockResolvedValue({ success: false, reset: Math.floor(Date.now() / 1000) + 60 });
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('503 Service Unavailable — tenant ingest disabled returns 503 with Retry-After: 3600', async () => {
    const { POST } = await loadRoute();
    ingestWebhookAttendeeMock.mockResolvedValue({
      ok: false,
      error: { kind: 'tenant_ingest_disabled' },
    });
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('3600');
  });

  it('5xx Internal Server Error — rolled-back tx returns 5xx + emits webhook_rolled_back in separate tx', async () => {
    const { POST } = await loadRoute();
    ingestWebhookAttendeeMock.mockResolvedValue({
      ok: false,
      error: { kind: 'rolled_back', failureStage: 'registration_insert', errorMessage: 'simulated FK failure' },
    });
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // Audit emission via separate-tx path
    expect(auditEmitRolledBackMock).toHaveBeenCalled();
  });
});
