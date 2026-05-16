/**
 * Round 1 CR-1 / TESTS-C-1 — Contract test: POST /api/admin/events
 *
 * The new admin-manual event creation route added by T026 (Feature 013 /
 * F6.1). Closes the "no way to seed events" gap left by EventCreate's
 * Enterprise-tier API gating (project_eventcreate_api_gated memory).
 *
 * Exercises every HTTP outcome the route returns:
 *   - 201 'created'        — fresh insert
 *   - 200 'already_exists' — idempotent re-post (same externalId)
 *   - 400 invalid-json     — body parse failure
 *   - 400 validation-error — zod schema failure (externalId regex, name length, etc.)
 *   - 400 from use-case `invalid_input` (defensive Application gate)
 *   - 429 rate-limited     — Upstash sliding window exhausted
 *   - 500 db_error         — use-case repository failure
 *   - 404 RBAC matrix      — manager / member / no-session
 *   - 404 kill-switch      — FEATURE_F6_EVENTCREATE = false
 *   - 500 tenant resolve   — resolveTenantFromRequest throws
 *
 * Mocks at module-boundary so no DB, no Upstash, no audit emit is hit.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams
// ---------------------------------------------------------------------------

const runCreateEventMock = vi.fn();
const createEventRateLimitCheckMock = vi.fn();
const getCurrentSessionMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const emitEventsRoleViolationMock = vi.fn();

vi.mock('@/lib/events-create-deps', () => ({
  runCreateEvent: (...args: unknown[]) => runCreateEventMock(...args),
  createEventRateLimitCheck: (...args: unknown[]) =>
    createEventRateLimitCheckMock(...args),
}));

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

vi.mock(
  '@/app/api/admin/events/_lib/role-violation-audit',
  () => ({
    emitEventsRoleViolation: (...args: unknown[]) =>
      emitEventsRoleViolationMock(...args),
  }),
);

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

// Staff-review R3v2 (2026-05-16): pre-warm the create-event route
// module — file total 20.7s in normal mode (17 tests). Under
// `pnpm test:coverage` v8 instrumentation the first test's
// cold-import would race the 30s testTimeout in parallel runs.
// `beforeAll` amortises into the 60s hookTimeout (vitest.config.ts).
beforeAll(async () => {
  await loadRoute();
});

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
  createEventRateLimitCheckMock.mockResolvedValue({
    success: true,
    resetAtUnixMs: Date.now() + 3_600_000,
  });
  emitEventsRoleViolationMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

async function loadRoute() {
  return (await import('@/app/api/admin/events/route')) as {
    POST: (req: NextRequest) => Promise<Response>;
  };
}

function jsonRequest(body: unknown, opts: { contentType?: string } = {}): NextRequest {
  return new NextRequest('http://test/api/admin/events', {
    method: 'POST',
    headers: { 'Content-Type': opts.contentType ?? 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const validBody = {
  externalId: 'agm-2026',
  name: 'SweCham AGM 2026',
  startDate: '2026-03-20T18:00:00+07:00',
  category: 'AGM',
};

const validCreatedOutcome = {
  kind: 'created' as const,
  event: {
    eventId: 'event-uuid-1',
    externalId: 'agm-2026',
    name: 'SweCham AGM 2026',
    startDate: new Date('2026-03-20T18:00:00+07:00'),
    category: 'AGM',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Round 1 CR-1 / TESTS-C-1 — POST /api/admin/events', () => {
  // Route handler cold-compile ~14s on first call.
  vi.setConfig({ testTimeout: 60_000 });

  describe('201 created — happy path', () => {
    it('returns 201 with kind=created + event payload (startDate as ISO string)', async () => {
      runCreateEventMock.mockResolvedValue(validCreatedOutcome);
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['kind']).toBe('created');
      const event = body['event'] as Record<string, unknown>;
      expect(event['eventId']).toBe('event-uuid-1');
      expect(event['externalId']).toBe('agm-2026');
      expect(event['name']).toBe('SweCham AGM 2026');
      // ISO-serialised Date.
      expect(event['startDate']).toMatch(/^2026-03-20T/);
      expect(event['category']).toBe('AGM');
    });

    it('passes correctly-branded actorUserId + tenantSlug to runCreateEvent', async () => {
      runCreateEventMock.mockResolvedValue(validCreatedOutcome);
      const { POST } = await loadRoute();
      await POST(jsonRequest(validBody));

      const call = runCreateEventMock.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(call['tenantSlug']).toBe(TENANT_SLUG);
      expect(call['actorUserId']).toBe(ADMIN_USER_ID);
      expect(call['externalId']).toBe('agm-2026');
      expect(call['name']).toBe('SweCham AGM 2026');
      expect(call['category']).toBe('AGM');
    });
  });

  describe('200 already_exists — idempotent retry', () => {
    it('returns 200 with kind=already_exists + same event payload', async () => {
      runCreateEventMock.mockResolvedValue({
        kind: 'already_exists' as const,
        event: { ...validCreatedOutcome.event },
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['kind']).toBe('already_exists');
    });
  });

  describe('400 — invalid input', () => {
    it('returns 400 invalid-json on malformed body', async () => {
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest('this is not json'));

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['type']).toMatch(/invalid-json/);
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 validation-error when externalId regex fails', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ ...validBody, externalId: 'has spaces' }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['type']).toMatch(/validation-error/);
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 validation-error when name is empty', async () => {
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({ ...validBody, name: '' }));

      expect(res.status).toBe(400);
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 validation-error when startDate is not ISO 8601', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ ...validBody, startDate: '2026-03-20' }),
      );

      expect(res.status).toBe(400);
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });

    it('returns 400 validation-error when externalId exceeds 100 chars', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ ...validBody, externalId: 'a'.repeat(101) }),
      );

      expect(res.status).toBe(400);
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });

    it('maps use-case invalid_input outcome to 400 with field hint in extras', async () => {
      runCreateEventMock.mockResolvedValue({
        kind: 'invalid_input' as const,
        field: 'externalId' as const,
        reason: 'externalId must be 1-100 chars, alphanumeric + hyphen only',
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['type']).toMatch(/validation-error/);
      expect(body['field']).toBe('externalId');
    });
  });

  describe('404 — RBAC matrix (surface-disclosure)', () => {
    it('returns 404 for manager session + emits role_violation_blocked audit', async () => {
      getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(404);
      expect(emitEventsRoleViolationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorRole: 'manager',
          attemptedAction: 'create_event',
        }),
      );
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });

    it('returns 404 for member session + emits role_violation_blocked audit', async () => {
      getCurrentSessionMock.mockResolvedValue(MEMBER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(404);
      expect(emitEventsRoleViolationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          actorRole: 'member',
          attemptedAction: 'create_event',
        }),
      );
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });

    it('returns 404 with NO audit emit for no-session', async () => {
      getCurrentSessionMock.mockResolvedValue(null);
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(404);
      expect(emitEventsRoleViolationMock).not.toHaveBeenCalled();
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });
  });

  // Kill-switch test moved to its own suite (`admin-events-create-killswitch.test.ts`)
  // — `vi.resetModules() + vi.doMock` permanently pollutes the worker's module cache
  // because Node's ESM resolver caches between tests inside the same file.

  describe('429 — rate-limit exhausted', () => {
    it('returns 429 with Retry-After header when rate-limit denies', async () => {
      createEventRateLimitCheckMock.mockResolvedValue({
        success: false,
        resetAtUnixMs: Date.now() + 300_000,
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).not.toBeNull();
      expect(runCreateEventMock).not.toHaveBeenCalled();
    });
  });

  describe('500 — use-case failures', () => {
    it('maps db_error outcome to 500 with generic detail', async () => {
      runCreateEventMock.mockResolvedValue({
        kind: 'db_error' as const,
        message: 'simulated postgres failure',
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['type']).toMatch(/internal/);
    });

    it('maps unexpected_error outcome to 500', async () => {
      runCreateEventMock.mockResolvedValue({
        kind: 'unexpected_error' as const,
        message: 'simulated throw',
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(500);
    });

    it('returns 500 when resolveTenantFromRequest throws', async () => {
      resolveTenantFromRequestMock.mockImplementation(() => {
        throw new Error('tenant resolve failed');
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      // R3 — requestId now hoisted so every 500 path carries the
      // correlation token (previously only the outer-catch did).
      expect(typeof body['requestId']).toBe('string');
    });

    it('R3 — returns 500 with requestId + admin_events_create_threw log when runCreateEvent throws', async () => {
      // Exercise the outer try/catch around runCreateEvent for the case
      // where runInTenant validation (asTenantContext) throws BEFORE
      // entering the use-case's own catch. Without this test, removing
      // the outer wrap would let the throw bubble out as an unbranded
      // Next.js 500 with no requestId, no log.
      runCreateEventMock.mockRejectedValueOnce(
        new Error('runInTenant: invalid tenant slug'),
      );
      const { logger } = await import('@/lib/logger');
      const loggerErrorSpy = vi.spyOn(logger, 'error');

      const { POST } = await loadRoute();
      const res = await POST(jsonRequest(validBody));

      expect(res.status).toBe(500);
      const body = (await res.json()) as Record<string, unknown>;
      expect(typeof body['requestId']).toBe('string');
      const loggedEvent = loggerErrorSpy.mock.calls.find(
        (call) =>
          call[0] !== null &&
          typeof call[0] === 'object' &&
          (call[0] as Record<string, unknown>)['event'] ===
            'admin_events_create_threw',
      );
      expect(loggedEvent).toBeDefined();
      loggerErrorSpy.mockRestore();
    });
  });

});
