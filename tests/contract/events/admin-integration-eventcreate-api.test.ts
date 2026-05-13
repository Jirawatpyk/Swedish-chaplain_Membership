/**
 * T068 — Contract test: /api/admin/integrations/eventcreate/**
 *
 * Spec authority:
 *   - specs/012-eventcreate-integration/contracts/admin-integration-eventcreate-api.md
 *   - FR-022 (config view), FR-024 (generate-secret one-time-reveal),
 *     FR-008 (rotate-secret 24h grace), FR-023 (test-webhook),
 *     FR-033 (disable), FR-035 (RBAC + surface disclosure 404 + audit).
 *
 * Exercises every documented HTTP outcome for the 5 admin endpoints
 * (GET config / POST generate / POST rotate / POST test / POST disable),
 * with the dependencies mocked at module-boundary so no DB, no Upstash,
 * no actual HMAC signing / fetch infrastructure is hit. Pattern mirrors
 * `tests/contract/events/admin-events-api.test.ts` (Phase 4) +
 * `tests/contract/events/webhook-eventcreate-v1.test.ts` (Phase 3).
 *
 * RED reason: the 5 route handler files do NOT exist yet (created by
 * T074 Phase 5 GREEN). The dynamic imports throw MODULE_NOT_FOUND so
 * EVERY test FAILS at suite-load. That IS the [RED — T068] marker.
 *
 * Turns GREEN: T074 lands the 5 route handlers + the
 * `@/lib/events-admin-integration-deps` composition adapter that
 * exposes the `runXxx` factories the tests mock here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams — composition adapter (T074) + auth + tenant + standalone audit.
// ---------------------------------------------------------------------------

// Untyped mocks during RED — when the real
// `@/lib/events-admin-integration-deps` module lands in T074 GREEN, this
// test gets a follow-up to add `vi.fn<typeof runXxx>()` compile-time
// anchors (HIGH-1 pattern established by admin-events-api.test.ts L62).
// Doing so now would require an `import type {...}` of a non-existent
// module — TS2307 + TS2578 churn during RED outweighs the typing
// benefit. The mock seam path is asserted at suite-load via
// `vi.mock('@/lib/events-admin-integration-deps', ...)` below; a typo
// would surface as TS module-resolution failure once the real adapter
// lands.
const runLoadIntegrationConfigMock = vi.fn();
const runGenerateWebhookSecretMock = vi.fn();
const runRotateWebhookSecretMock = vi.fn();
const runRunTestWebhookMock = vi.fn();
const runDisableIngestMock = vi.fn();
const rotateSecretRateLimitCheckMock = vi.fn();
const testWebhookRateLimitCheckMock = vi.fn();

const getCurrentSessionMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const emitStandaloneMock = vi.fn();

vi.mock('@/lib/events-admin-integration-deps', () => ({
  runLoadIntegrationConfig: (...args: unknown[]) => runLoadIntegrationConfigMock(...args),
  runGenerateWebhookSecret: (...args: unknown[]) => runGenerateWebhookSecretMock(...args),
  runRotateWebhookSecret: (...args: unknown[]) => runRotateWebhookSecretMock(...args),
  runRunTestWebhook: (...args: unknown[]) => runRunTestWebhookMock(...args),
  // Round 2 simplifier P3 (2026-05-13) — canonical name only;
  // `runDisableIngest` deprecated alias was dropped this round.
  // Variable name kept (`runDisableIngestMock`) for test-mock
  // historical clarity; could be renamed in a follow-up sweep.
  runToggleIngest: (...args: unknown[]) => runDisableIngestMock(...args),
  rotateSecretRateLimitCheck: (...args: unknown[]) => rotateSecretRateLimitCheckMock(...args),
  testWebhookRateLimitCheck: (...args: unknown[]) => testWebhookRateLimitCheckMock(...args),
}));

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) => resolveTenantFromRequestMock(...args),
}));

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>('@/modules/events');
  return {
    ...actual,
    makeStandaloneAuditDeps: () => ({
      emitStandalone: (...args: unknown[]) => emitStandaloneMock(...args),
    }),
  };
});

// Feature flag: route handlers gate on `env.features.f6EventCreate`.
// Mock at boot so each test sees the flag flipped on.
vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: {
        ...actual.env.features,
        f6EventCreate: true,
      },
      tenant: { slug: 'test-swecham' },
    },
  };
});

const TENANT_SLUG = 'test-swecham';
const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';

const ADMIN_SESSION = {
  session: { id: 'sess-admin', userId: ADMIN_USER_ID } as unknown,
  user: { id: ADMIN_USER_ID, role: 'admin' as const, email: 'admin@test' },
};
const MANAGER_SESSION = {
  session: { id: 'sess-manager', userId: 'mgr' } as unknown,
  user: { id: 'mgr', role: 'manager' as const, email: 'mgr@test' },
};
const MEMBER_SESSION = {
  session: { id: 'sess-member', userId: 'mem' } as unknown,
  user: { id: 'mem', role: 'member' as const, email: 'mem@test' },
};

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
  rotateSecretRateLimitCheckMock.mockResolvedValue({ success: true, resetAtUnixMs: Date.now() + 3_600_000 });
  testWebhookRateLimitCheckMock.mockResolvedValue({ success: true, resetAtUnixMs: Date.now() + 3_600_000 });
  emitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Dynamic route loaders — RED until T074 lands.
// ---------------------------------------------------------------------------

async function loadGetRoute() {
  try {
    return (await import(
      '@/app/api/admin/integrations/eventcreate/route'
    )) as {
      GET: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[RED — T068] GET route not yet implemented (T074). Import error: ${msg}`);
  }
}

async function loadGenerateSecretRoute() {
  try {
    return (await import(
      '@/app/api/admin/integrations/eventcreate/generate-secret/route'
    )) as {
      POST: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[RED — T068] generate-secret POST not yet implemented (T074). ${msg}`);
  }
}

async function loadRotateSecretRoute() {
  try {
    return (await import(
      '@/app/api/admin/integrations/eventcreate/rotate-secret/route'
    )) as {
      POST: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[RED — T068] rotate-secret POST not yet implemented (T074). ${msg}`);
  }
}

async function loadTestWebhookRoute() {
  try {
    return (await import(
      '@/app/api/admin/integrations/eventcreate/test-webhook/route'
    )) as {
      POST: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[RED — T068] test-webhook POST not yet implemented (T074). ${msg}`);
  }
}

async function loadDisableRoute() {
  try {
    return (await import(
      '@/app/api/admin/integrations/eventcreate/disable/route'
    )) as {
      POST: (req: NextRequest) => Promise<Response>;
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`[RED — T068] disable POST not yet implemented (T074). ${msg}`);
  }
}

function buildGet(url = `https://app.test/api/admin/integrations/eventcreate`): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

function buildPost(
  pathSegment: string,
  body: unknown = {},
): NextRequest {
  return new NextRequest(`https://app.test/api/admin/integrations/eventcreate/${pathSegment}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

// ===========================================================================
// GET /api/admin/integrations/eventcreate
// ===========================================================================

describe('GET /api/admin/integrations/eventcreate', () => {
  it('200 with configured secret returns masked payload + recent deliveries (default filters tests)', async () => {
    runLoadIntegrationConfigMock.mockResolvedValueOnce({
      webhookUrl: `https://app.test/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      secretConfigured: true,
      secretLastFour: '1a2b',
      graceActiveUntil: null,
      ingestEnabled: true,
      lastReceivedAt: '2026-06-01T10:23:15Z',
      recentDeliveries: [
        {
          receivedAt: '2026-06-01T10:23:15Z',
          requestId: '01ARZ',
          signatureOutcome: 'verified',
          processingOutcome: 'matched_member_contact',
          matchedMemberId: 'mem-1',
          registrationId: 'reg-1',
        },
      ],
      recentDeliveriesIncludeTests: false,
    });

    const { GET } = await loadGetRoute();
    const res = await GET(buildGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secretConfigured).toBe(true);
    expect(body.secretLastFour).toBe('1a2b');
    expect(body.recentDeliveriesIncludeTests).toBe(false);
    expect(body.webhookUrl).toContain(`/api/webhooks/eventcreate/v1/${TENANT_SLUG}`);
    expect(body.recentDeliveries).toHaveLength(1);
  });

  it('200 first visit returns secretConfigured=false + empty recentDeliveries', async () => {
    runLoadIntegrationConfigMock.mockResolvedValueOnce({
      webhookUrl: `https://app.test/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      secretConfigured: false,
      ingestEnabled: false,
      recentDeliveries: [],
      recentDeliveriesIncludeTests: false,
    });

    const { GET } = await loadGetRoute();
    const res = await GET(buildGet());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secretConfigured).toBe(false);
    expect(body.recentDeliveries).toEqual([]);
    expect(body.secretLastFour).toBeUndefined();
  });

  it('200 with includeTestDeliveries=true passes flag through to use-case', async () => {
    runLoadIntegrationConfigMock.mockResolvedValueOnce({
      webhookUrl: `https://app.test/api/webhooks/eventcreate/v1/${TENANT_SLUG}`,
      secretConfigured: true,
      secretLastFour: '1a2b',
      graceActiveUntil: null,
      ingestEnabled: true,
      lastReceivedAt: null,
      recentDeliveries: [],
      recentDeliveriesIncludeTests: true,
    });

    const { GET } = await loadGetRoute();
    const res = await GET(
      buildGet(`https://app.test/api/admin/integrations/eventcreate?includeTestDeliveries=true`),
    );
    expect(res.status).toBe(200);
    expect(runLoadIntegrationConfigMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      expect.objectContaining({ includeTestDeliveries: true }),
    );
  });

  it('404 when manager attempts to view + emits role_violation_blocked audit', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(MANAGER_SESSION);
    const { GET } = await loadGetRoute();
    const res = await GET(buildGet());
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        actorType: 'manager',
        payload: expect.objectContaining({
          actorRole: 'manager',
          attemptedRoute: '/api/admin/integrations/eventcreate',
          attemptedAction: 'load_integration_config',
        }),
      }),
    );
    expect(runLoadIntegrationConfigMock).not.toHaveBeenCalled();
  });

  it('404 when member attempts to view + emits role_violation_blocked audit', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(MEMBER_SESSION);
    const { GET } = await loadGetRoute();
    const res = await GET(buildGet());
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        actorType: 'member',
      }),
    );
  });

  it('404 when no session', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);
    const { GET } = await loadGetRoute();
    const res = await GET(buildGet());
    expect(res.status).toBe(404);
    expect(runLoadIntegrationConfigMock).not.toHaveBeenCalled();
    // No audit when no session (no actor to attribute).
    expect(emitStandaloneMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/admin/integrations/eventcreate/generate-secret
// ===========================================================================

describe('POST /api/admin/integrations/eventcreate/generate-secret', () => {
  it('200 returns plaintext secret + secretLastFour on success', async () => {
    runGenerateWebhookSecretMock.mockResolvedValueOnce({
      ok: true,
      value: { secret: 'whsec_TEST_FULL_VALUE', secretLastFour: 'alue' },
    });
    const { POST } = await loadGenerateSecretRoute();
    const res = await POST(buildPost('generate-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.secret).toBe('whsec_TEST_FULL_VALUE');
    expect(body.secretLastFour).toBe('alue');
    expect(body.warning).toBeDefined();
  });

  it('409 Conflict when secret already exists', async () => {
    runGenerateWebhookSecretMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'secret_already_exists' },
    });
    const { POST } = await loadGenerateSecretRoute();
    const res = await POST(buildPost('generate-secret'));
    expect(res.status).toBe(409);
  });

  it('404 + audit when manager attempts generate-secret', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(MANAGER_SESSION);
    const { POST } = await loadGenerateSecretRoute();
    const res = await POST(buildPost('generate-secret'));
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        payload: expect.objectContaining({ attemptedAction: 'generate_webhook_secret' }),
      }),
    );
    expect(runGenerateWebhookSecretMock).not.toHaveBeenCalled();
  });

  it('404 + audit when member attempts generate-secret', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(MEMBER_SESSION);
    const { POST } = await loadGenerateSecretRoute();
    const res = await POST(buildPost('generate-secret'));
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// POST /api/admin/integrations/eventcreate/rotate-secret
// ===========================================================================

describe('POST /api/admin/integrations/eventcreate/rotate-secret', () => {
  it('200 returns new secret + graceActiveUntil 24h ahead', async () => {
    runRotateWebhookSecretMock.mockResolvedValueOnce({
      ok: true,
      value: {
        secret: 'whsec_NEW_VALUE',
        secretLastFour: '3c4d',
        graceActiveUntil: '2026-05-13T08:42:00Z',
      },
    });
    const { POST } = await loadRotateSecretRoute();
    const res = await POST(buildPost('rotate-secret'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.secret).toBe('whsec_NEW_VALUE');
    expect(body.secretLastFour).toBe('3c4d');
    expect(body.graceActiveUntil).toBe('2026-05-13T08:42:00Z');
    expect(body.warning).toBeDefined();
  });

  it('429 when rotation rate-limit (3/hr per tenant+actor) is exceeded', async () => {
    rotateSecretRateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      resetAtUnixMs: Date.now() + 3_600_000,
    });
    const { POST } = await loadRotateSecretRoute();
    const res = await POST(buildPost('rotate-secret'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
    expect(runRotateWebhookSecretMock).not.toHaveBeenCalled();
  });

  it('rate-limit key is namespaced per (tenant, actor)', async () => {
    runRotateWebhookSecretMock.mockResolvedValueOnce({
      ok: true,
      value: {
        secret: 'whsec_X',
        secretLastFour: 'wxyz',
        graceActiveUntil: '2026-05-13T00:00:00Z',
      },
    });
    const { POST } = await loadRotateSecretRoute();
    await POST(buildPost('rotate-secret'));
    expect(rotateSecretRateLimitCheckMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      ADMIN_USER_ID,
    );
  });

  it('404 + audit when manager attempts rotate-secret', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(MANAGER_SESSION);
    const { POST } = await loadRotateSecretRoute();
    const res = await POST(buildPost('rotate-secret'));
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        payload: expect.objectContaining({ attemptedAction: 'rotate_webhook_secret' }),
      }),
    );
    expect(runRotateWebhookSecretMock).not.toHaveBeenCalled();
  });

  it('500 when use-case returns db_error', async () => {
    runRotateWebhookSecretMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'db_error', message: 'connection lost' },
    });
    const { POST } = await loadRotateSecretRoute();
    const res = await POST(buildPost('rotate-secret'));
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// POST /api/admin/integrations/eventcreate/test-webhook
// ===========================================================================

describe('POST /api/admin/integrations/eventcreate/test-webhook', () => {
  it('200 ok=true with round-trip success', async () => {
    runRunTestWebhookMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ok: true,
        requestId: 'test-01H',
        deliveredAt: '2026-05-12T08:43:11Z',
        verifiedAt: '2026-05-12T08:43:11Z',
        processingOutcome: 'short_circuited_test',
        durationMs: 142,
      },
    });
    const { POST } = await loadTestWebhookRoute();
    const res = await POST(buildPost('test-webhook'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.requestId).toBe('test-01H');
    expect(body.processingOutcome).toBe('short_circuited_test');
    expect(body.durationMs).toBe(142);
  });

  it('200 ok=false when synthetic delivery verification fails', async () => {
    runRunTestWebhookMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ok: false,
        requestId: 'test-02H',
        deliveredAt: '2026-05-12T08:43:11Z',
        signatureOutcome: 'rejected',
        failureCategory: 'signature_mismatch',
        hint: 'Did you save the secret correctly?',
      },
    });
    const { POST } = await loadTestWebhookRoute();
    const res = await POST(buildPost('test-webhook'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.failureCategory).toBe('signature_mismatch');
    expect(body.hint).toBeDefined();
  });

  it('429 when test-webhook rate-limit (10/hr per tenant+actor) is exceeded', async () => {
    testWebhookRateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      resetAtUnixMs: Date.now() + 3_600_000,
    });
    const { POST } = await loadTestWebhookRoute();
    const res = await POST(buildPost('test-webhook'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeDefined();
    expect(runRunTestWebhookMock).not.toHaveBeenCalled();
  });

  it('rate-limit key is namespaced per (tenant, actor)', async () => {
    runRunTestWebhookMock.mockResolvedValueOnce({
      ok: true,
      value: {
        ok: true,
        requestId: 'test-z',
        deliveredAt: '2026-05-12T08:00:00Z',
        verifiedAt: '2026-05-12T08:00:00Z',
        processingOutcome: 'short_circuited_test',
        durationMs: 10,
      },
    });
    const { POST } = await loadTestWebhookRoute();
    await POST(buildPost('test-webhook'));
    expect(testWebhookRateLimitCheckMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      ADMIN_USER_ID,
    );
  });

  it('404 + audit when manager attempts test-webhook', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(MANAGER_SESSION);
    const { POST } = await loadTestWebhookRoute();
    const res = await POST(buildPost('test-webhook'));
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        payload: expect.objectContaining({ attemptedAction: 'run_test_webhook' }),
      }),
    );
    expect(runRunTestWebhookMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// POST /api/admin/integrations/eventcreate/disable
// ===========================================================================

describe('POST /api/admin/integrations/eventcreate/disable', () => {
  it('200 when admin disables ingest with reason', async () => {
    runDisableIngestMock.mockResolvedValueOnce({ ok: true, value: { enabled: false } });
    const { POST } = await loadDisableRoute();
    const res = await POST(
      buildPost('disable', { enabled: false, reason: 'incident response' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(runDisableIngestMock).toHaveBeenCalledWith(
      TENANT_SLUG,
      ADMIN_USER_ID,
      expect.objectContaining({ enabled: false, reason: 'incident response' }),
    );
  });

  it('200 when admin re-enables ingest', async () => {
    runDisableIngestMock.mockResolvedValueOnce({ ok: true, value: { enabled: true } });
    const { POST } = await loadDisableRoute();
    const res = await POST(
      buildPost('disable', { enabled: true, reason: 'incident resolved' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
  });

  it('400 when body is malformed (missing reason)', async () => {
    const { POST } = await loadDisableRoute();
    const res = await POST(buildPost('disable', { enabled: false }));
    expect(res.status).toBe(400);
    expect(runDisableIngestMock).not.toHaveBeenCalled();
  });

  it('400 when body is malformed (non-boolean enabled)', async () => {
    const { POST } = await loadDisableRoute();
    const res = await POST(buildPost('disable', { enabled: 'yes', reason: 'x' }));
    expect(res.status).toBe(400);
  });

  it('404 + audit when manager attempts disable', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(MANAGER_SESSION);
    const { POST } = await loadDisableRoute();
    const res = await POST(
      buildPost('disable', { enabled: false, reason: 'attempt' }),
    );
    expect(res.status).toBe(404);
    expect(emitStandaloneMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'role_violation_blocked',
        payload: expect.objectContaining({ attemptedAction: 'disable_ingest' }),
      }),
    );
    expect(runDisableIngestMock).not.toHaveBeenCalled();
  });

  it('404 when use-case returns not_found (no config row exists)', async () => {
    runDisableIngestMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'not_found' },
    });
    const { POST } = await loadDisableRoute();
    const res = await POST(
      buildPost('disable', { enabled: true, reason: 'reactivate' }),
    );
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// Round-6 verify-fix 2026-05-13 (M3) — `audit_emit_failed` → 500 mapping
// for the 4 mutating endpoints. The composition adapter returns
// `{ ok: false, error: { kind: 'audit_emit_failed' } }` when the DB row
// mutated but the audit emit failed (Principle I sub-clause 5 forensic-
// trail gap). Route handlers MUST surface this as 500 so the admin
// retries — never as 200 (which would mask the gap).
// ===========================================================================

describe('M3 — audit_emit_failed → 500 mapping (forensic-trail gap surfaces as retry)', () => {
  it('generate-secret returns 500 when use-case returns audit_emit_failed', async () => {
    runGenerateWebhookSecretMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'audit_emit_failed', inner: { kind: 'db_error', message: 'audit insert failed' } },
    });
    const { POST } = await loadGenerateSecretRoute();
    const res = await POST(buildPost('generate-secret'));
    expect(res.status).toBe(500);
  });

  it('rotate-secret returns 500 when use-case returns audit_emit_failed', async () => {
    runRotateWebhookSecretMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'audit_emit_failed', inner: { kind: 'db_error', message: 'audit insert failed' } },
    });
    const { POST } = await loadRotateSecretRoute();
    const res = await POST(buildPost('rotate-secret'));
    expect(res.status).toBe(500);
  });

  it('disable returns 500 when use-case returns audit_emit_failed', async () => {
    runDisableIngestMock.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'audit_emit_failed', message: 'audit emit failed' },
    });
    const { POST } = await loadDisableRoute();
    const res = await POST(
      buildPost('disable', { enabled: false, reason: 'test' }),
    );
    expect(res.status).toBe(500);
  });
});

// ===========================================================================
// FR-035 kill-switch behaviour — applies to all 5 endpoints uniformly
// ===========================================================================

describe('FR-035 kill-switch — all endpoints return 404 when FEATURE_F6_EVENTCREATE is false', () => {
  // Each endpoint must independently honour the kill-switch. We test each
  // briefly so a future "audit emit before kill-switch check" regression
  // (cardinality leak via emit-before-flag) is caught at contract level.
  beforeEach(() => {
    // Override the boot mock for this describe block only.
    vi.doMock('@/lib/env', async () => {
      const actual =
        await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
      return {
        ...actual,
        env: {
          ...actual.env,
          features: { ...actual.env.features, f6EventCreate: false },
          tenant: { slug: TENANT_SLUG },
        },
      };
    });
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@/lib/env');
    vi.resetModules();
  });

  it.each([
    ['GET config', () => loadGetRoute().then((m) => m.GET(buildGet()))],
    ['POST generate-secret', () => loadGenerateSecretRoute().then((m) => m.POST(buildPost('generate-secret')))],
    ['POST rotate-secret', () => loadRotateSecretRoute().then((m) => m.POST(buildPost('rotate-secret')))],
    ['POST test-webhook', () => loadTestWebhookRoute().then((m) => m.POST(buildPost('test-webhook')))],
    ['POST disable', () => loadDisableRoute().then((m) => m.POST(buildPost('disable', { enabled: false, reason: 'k' })))],
  ])('%s returns 404 when kill-switch is off', async (_name, fn) => {
    const res = await fn();
    expect(res.status).toBe(404);
  });
});
