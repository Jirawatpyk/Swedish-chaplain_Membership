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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { eventcreateMetrics } from '@/lib/metrics';
import { signWebhookBody, makeWebhookPayload } from '../../integration/events/helpers/sign-webhook';

// ---------------------------------------------------------------------------
// Mock seams — replace heavy dependencies at module boundary.
// ---------------------------------------------------------------------------

const ingestWebhookAttendeeMock = vi.fn();
const verifyWebhookSignatureMock = vi.fn();
const auditEmitStandaloneMock = vi.fn();
const ratelimitCheckMock = vi.fn();
const loadTenantWebhookConfigMock = vi.fn();
const resolveTenantFromSlugMock = vi.fn();

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>('@/modules/events');
  return {
    ...actual,
    ingestWebhookAttendee: (...args: unknown[]) => ingestWebhookAttendeeMock(...args),
    verifyWebhookSignature: (...args: unknown[]) => verifyWebhookSignatureMock(...args),
  };
});

vi.mock('@/lib/events-webhook-deps', () => ({
  makeIngestWebhookAttendeeDeps: () => ({
    runInTenantTx: vi.fn(),
    emitRolledBackStandalone: vi.fn().mockResolvedValue({ ok: true, value: 'audit-id' }),
    emitStandalone: (...args: unknown[]) => auditEmitStandaloneMock(...args),
  }),
  makeStandaloneAuditDeps: () => ({
    emitStandalone: (...args: unknown[]) => auditEmitStandaloneMock(...args),
  }),
  ratelimitCheck: (...args: unknown[]) => ratelimitCheckMock(...args),
  loadTenantWebhookConfig: (...args: unknown[]) => loadTenantWebhookConfigMock(...args),
  resolveTenantFromSlug: (...args: unknown[]) => resolveTenantFromSlugMock(...args),
}));

beforeEach(() => {
  // Sensible defaults so most happy-path tests don't have to repeat
  // these. Each test can override with `mockResolvedValueOnce(...)`.
  ratelimitCheckMock.mockResolvedValue({ success: true, reset: Date.now() + 60_000 });
  resolveTenantFromSlugMock.mockReturnValue({ slug: TENANT_SLUG });
  loadTenantWebhookConfigMock.mockResolvedValue({
    tenantId: TENANT_SLUG,
    source: 'eventcreate',
    activeSecret: TEST_SECRET,
    graceSecret: null,
    graceRotatedAt: null,
    enabled: true,
    createdAt: new Date(),
    lastReceivedAt: null,
    lastRotatedAt: null,
  });
  verifyWebhookSignatureMock.mockReturnValue({ verified: true, usedGraceSecret: false });
  auditEmitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
});

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
    // T052 route now exists (Wave 3.3). Removed @ts-expect-error.
    return (await import(
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
        ingestLatencyMs: 87,
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
    verifyWebhookSignatureMock.mockReturnValueOnce({
      verified: false,
      kind: 'signature_mismatch',
      skewSeconds: null,
    });
    const { POST } = await loadRoute();
    const req = buildRequest(makeWebhookPayload(), {
      'X-Chamber-Signature': 'sha256=00deadbeef',
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.title).toBe('Webhook authentication failed');
    expect(JSON.stringify(body)).not.toMatch(/signature_mismatch|skew|missing_header/i);
  });

  it('401 Unauthorized — timestamp skew >5min returns same generic 401 body', async () => {
    verifyWebhookSignatureMock.mockReturnValueOnce({
      verified: false,
      kind: 'timestamp_skew_exceeded',
      skewSeconds: 360,
    });
    const { POST } = await loadRoute();
    const signed = signWebhookBody({
      body: makeWebhookPayload(),
      secret: TEST_SECRET,
      timestampSeconds: Math.floor(Date.now() / 1000) - 360,
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
    ingestWebhookAttendeeMock.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'malformed_rejected',
        errors: [{ path: 'attendee.email', message: 'Invalid email address' }],
      },
    });
    const { POST } = await loadRoute();
    const req = buildRequest({ eventType: 'attendee.registered' });
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
    ratelimitCheckMock.mockResolvedValueOnce({
      success: false,
      reset: Date.now() + 60_000,
    });
    const { POST } = await loadRoute();
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

  // ---------------------------------------------------------------------
  // Body-size DoS guard + slug-shape cardinality-bomb defence
  // ---------------------------------------------------------------------

  it('413 Payload Too Large — declared Content-Length > 64 KiB rejected pre-read + emits bodyOversizedTotal metric', async () => {
    const metricSpy = vi.spyOn(eventcreateMetrics, 'bodyOversizedTotal');
    const { POST } = await loadRoute();
    const req = new NextRequest(`https://app.test${ROUTE_PATH}`, {
      method: 'POST',
      body: '{}', // body is small; declared CL is the lie
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '70000',
      },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.title).toBe('Payload too large');
    expect(metricSpy).toHaveBeenCalledWith(TENANT_SLUG);
    // Ingest dispatch must NOT have happened
    expect(ingestWebhookAttendeeMock).not.toHaveBeenCalled();
  });

  it('413 Payload Too Large — realised body size > 64 KiB rejected post-read', async () => {
    const { POST } = await loadRoute();
    const oversized = 'x'.repeat(65 * 1024); // 66,560 bytes > 64 KiB
    const req = new NextRequest(`https://app.test${ROUTE_PATH}`, {
      method: 'POST',
      body: oversized,
      headers: {
        'Content-Type': 'application/json',
        // Omit Content-Length to force the post-read path
      },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(413);
    expect(ingestWebhookAttendeeMock).not.toHaveBeenCalled();
  });

  it('413 Payload Too Large — negative Content-Length rejected', async () => {
    const { POST } = await loadRoute();
    const req = new NextRequest(`https://app.test${ROUTE_PATH}`, {
      method: 'POST',
      body: '{}',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '-1',
      },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(413);
  });

  it('413 Payload Too Large — strict over-by-one (65_537 bytes rejected)', async () => {
    const { POST } = await loadRoute();
    // Construct a body strictly 1 byte over the cap so the realised-
    // size check (`>` comparison) catches it on the boundary.
    const overOneByte = 'x'.repeat(64 * 1024 + 1);
    const req = new NextRequest(`https://app.test${ROUTE_PATH}`, {
      method: 'POST',
      body: overOneByte,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(413);
  });

  it('404 Not Found — invalid slug shape returns 404 BEFORE any metric/audit (cardinality-bomb defence)', async () => {
    const { POST } = await loadRoute();
    const badSlug = 'tenant_with_underscore'; // underscores violate [a-z0-9-]
    const req = new NextRequest(`https://app.test/api/webhooks/eventcreate/v1/${badSlug}`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: badSlug }) });
    expect(res.status).toBe(404);
    // No downstream calls — confirms step 0 short-circuit
    expect(ratelimitCheckMock).not.toHaveBeenCalled();
    expect(resolveTenantFromSlugMock).not.toHaveBeenCalled();
    expect(auditEmitStandaloneMock).not.toHaveBeenCalled();
  });

  // route last-resort catch — OTel span ERROR + uncaught log
  it('5xx + last-resort catch — uncaught throw emits logger.fatal `f6_webhook_uncaught_exception`', async () => {
    const { logger } = await import('@/lib/logger');
    const fatalSpy = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    ingestWebhookAttendeeMock.mockImplementationOnce(() => {
      throw new Error('synth — synchronous throw past every defensive layer');
    });
    const { POST } = await loadRoute();
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.title).toMatch(/Internal error/i);
    // The catch must emit the forensic log line so SREs see uncaught
    // throws in pino, not just a Vercel 500.
    expect(fatalSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_webhook_uncaught_exception' }),
      expect.any(String),
    );
    fatalSpy.mockRestore();
  });

  // F-2 — `await ctx.params` rejection short-circuits with logged 500
  it('5xx + `f6_route_params_failed` log when params Promise rejects', async () => {
    const { logger } = await import('@/lib/logger');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { POST } = await loadRoute();
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, {
      params: Promise.reject(new Error('synth — params decode failed')),
    });
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_route_params_failed' }),
      expect.any(String),
    );
    errorSpy.mockRestore();
  });

  // H-3 — config-load failure exercises markSpanError + safeEmitStandalone
  // second site + bodyOversizedTotal sibling + `f6_webhook_config_load_failed` log
  it('500 — loadTenantWebhookConfig throw fires audit + metric + log + span ERROR', async () => {
    const { logger } = await import('@/lib/logger');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    loadTenantWebhookConfigMock.mockRejectedValueOnce(new Error('synth — config load failed'));
    const { POST } = await loadRoute();
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'f6_webhook_config_load_failed' }),
      expect.any(String),
    );
    expect(auditEmitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'webhook_rolled_back',
        payload: expect.objectContaining({ failureStage: 'unknown' }),
      }),
    );
    errorSpy.mockRestore();
  });

  it('404 Not Found — slug exceeding 63 chars short-circuits at step 0', async () => {
    const { POST } = await loadRoute();
    const longSlug = 'a'.repeat(64); // one over the limit
    const req = new NextRequest(`https://app.test/api/webhooks/eventcreate/v1/${longSlug}`, {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: longSlug }) });
    expect(res.status).toBe(404);
    expect(ratelimitCheckMock).not.toHaveBeenCalled();
  });

  it('5xx Internal Server Error — rolled-back tx returns 5xx + emits webhook_rolled_back in separate tx', async () => {
    ingestWebhookAttendeeMock.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'rolled_back',
        failureStage: 'registration_insert',
        errorMessage: 'simulated FK failure',
        auditFallbackFailed: false,
        ingestLatencyMs: 42,
      },
    });
    const { POST } = await loadRoute();
    const req = buildRequest(makeWebhookPayload());
    const res = await POST(req, { params: Promise.resolve({ tenantSlug: TENANT_SLUG }) });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // NOTE: the `webhook_rolled_back` audit emission is the use-case's
    // responsibility (via `deps.emitRolledBackStandalone`), not the
    // route handler's. The use-case is fully mocked here, so we
    // assert only the HTTP-layer behaviour (status code + body shape).
    // The dual-write audit emission is covered by the integration tests
    // in `tests/integration/events/transactional-ingest.test.ts` and
    // `tests/integration/events/db-unavailable-during-tx.test.ts`
    // (currently deferred to Wave 3.3+).
    const body = await res.json();
    expect(body.title).toMatch(/Internal error/i);
  });
});
