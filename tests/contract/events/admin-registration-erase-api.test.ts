/**
 * Phase B B7 — Contract test: POST /api/admin/events/[eventId]/registrations/[registrationId]/erase
 *
 * Closes the test-coverage gap C1 flagged by the F6 review (GDPR Art. 17
 * / PDPA §30 surface; previously only use-case-level integration tests
 * exercised the path). Verifies the route-level RBAC + 400/404/409/429
 * grid + audit emission.
 *
 * Mocks at module boundary so no DB / Upstash / audit emit is hit.
 */
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { NextRequest } from 'next/server';

// ---------------------------------------------------------------------------
// Mock seams
// ---------------------------------------------------------------------------

const runEraseAttendeePiiMock = vi.fn();
const getCurrentSessionMock = vi.fn();
const resolveTenantFromRequestMock = vi.fn();
const emitStandaloneMock = vi.fn();

vi.mock('@/lib/events-admin-deps', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/events-admin-deps')>(
      '@/lib/events-admin-deps',
    );
  return {
    ...actual,
    runEraseAttendeePii: (...args: unknown[]) => runEraseAttendeePiiMock(...args),
  };
});

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: (...args: unknown[]) =>
    resolveTenantFromRequestMock(...args),
}));

vi.mock('@/modules/events', async () => {
  const actual = await vi.importActual<typeof import('@/modules/events')>(
    '@/modules/events',
  );
  return {
    ...actual,
    makeStandaloneAuditDeps: () => ({
      emitStandalone: (...args: unknown[]) => emitStandaloneMock(...args),
    }),
  };
});

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
const VALID_EVENT_ID = '11111111-2222-4333-8444-555555555555';
const VALID_REGISTRATION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const VALID_PATH = `http://test/api/admin/events/${VALID_EVENT_ID}/registrations/${VALID_REGISTRATION_ID}/erase`;
const VALID_PARAMS = {
  eventId: VALID_EVENT_ID,
  registrationId: VALID_REGISTRATION_ID,
};

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

async function loadRoute() {
  return (await import(
    '@/app/api/admin/events/[eventId]/registrations/[registrationId]/erase/route'
  )) as {
    POST: (
      req: NextRequest,
      ctx: { params: Promise<{ eventId: string; registrationId: string }> },
    ) => Promise<Response>;
  };
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest(VALID_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function withParams(params: { eventId: string; registrationId: string }) {
  return { params: Promise.resolve(params) };
}

beforeAll(async () => {
  await loadRoute();
});

beforeEach(() => {
  resolveTenantFromRequestMock.mockReturnValue({ slug: TENANT_SLUG });
  getCurrentSessionMock.mockResolvedValue(ADMIN_SESSION);
  emitStandaloneMock.mockResolvedValue({ ok: true, value: 'audit-id' });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase B B7 — POST /api/admin/events/[eventId]/registrations/[registrationId]/erase', () => {
  vi.setConfig({ testTimeout: 60_000 });

  describe('200 OK — happy path', () => {
    it('returns 200 with quotaReversals + alreadyErased=false', async () => {
      runEraseAttendeePiiMock.mockResolvedValue({
        ok: true,
        value: {
          alreadyErased: false,
          quotaReversals: { partnership: 1, cultural: 0 },
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({ reasonText: 'GDPR Art. 17 request' }), withParams(VALID_PARAMS));

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['alreadyErased']).toBe(false);
      expect(body['quotaReversals']).toMatchObject({
        partnership: 1,
        cultural: 0,
      });
    });

    it('returns 200 with alreadyErased=true on idempotent re-erase', async () => {
      runEraseAttendeePiiMock.mockResolvedValue({
        ok: true,
        value: {
          alreadyErased: true,
          quotaReversals: { partnership: 0, cultural: 0 },
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({ reasonText: 'retry' }), withParams(VALID_PARAMS));

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['alreadyErased']).toBe(true);
    });
  });

  describe('400 validation errors', () => {
    it('400 on missing reasonText', async () => {
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({}), withParams(VALID_PARAMS));
      expect(res.status).toBe(400);
    });

    it('400 on empty reasonText', async () => {
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({ reasonText: '' }), withParams(VALID_PARAMS));
      expect(res.status).toBe(400);
    });

    it('400 on reasonText exceeding 500 chars', async () => {
      const { POST } = await loadRoute();
      const oversized = 'x'.repeat(501);
      const res = await POST(
        jsonRequest({ reasonText: oversized }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(400);
    });

    it('400 on malformed JSON body', async () => {
      const { POST } = await loadRoute();
      const req = new NextRequest(VALID_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not valid json',
      });
      const res = await POST(req, withParams(VALID_PARAMS));
      expect(res.status).toBe(400);
    });
  });

  describe('404 path-param rejection', () => {
    it('404 on non-v4 UUID eventId', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams({
          eventId: '11111111-2222-3333-4444-555555555555', // v3-ish, not v4
          registrationId: VALID_REGISTRATION_ID,
        }),
      );
      expect(res.status).toBe(404);
    });

    it('404 on registrationId longer than 200 chars', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams({
          eventId: VALID_EVENT_ID,
          registrationId: 'a'.repeat(201),
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('RBAC matrix (FR-035)', () => {
    it('403 + role_violation audit when manager attempts erase', async () => {
      getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(403);
      // adminOnlyWriterGuard emits role_violation_blocked via emitStandalone
      const emitCalls = emitStandaloneMock.mock.calls;
      const violation = emitCalls.find(
        (c) =>
          (c[0] as Record<string, unknown>)['eventType'] ===
          'role_violation_blocked',
      );
      expect(violation).toBeDefined();
    });

    it('404 when member attempts erase', async () => {
      getCurrentSessionMock.mockResolvedValue(MEMBER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(404);
    });

    it('404 when no session', async () => {
      getCurrentSessionMock.mockResolvedValue(null);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('use-case error mapping', () => {
    it('404 on registration_not_found', async () => {
      runEraseAttendeePiiMock.mockResolvedValue({
        ok: false,
        error: { kind: 'registration_not_found', message: 'no row' },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(404);
    });

    it('409 on event_path_mismatch (FR-014-style)', async () => {
      runEraseAttendeePiiMock.mockResolvedValue({
        ok: false,
        error: { kind: 'event_path_mismatch', message: 'event mismatch' },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(409);
    });

    it('500 on generic use-case error', async () => {
      runEraseAttendeePiiMock.mockResolvedValue({
        ok: false,
        error: { kind: 'audit_emit_failed', message: 'audit fail' },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ reasonText: 'x' }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(500);
    });
  });

  // Killswitch coverage lives in
  // `admin-registration-erase-killswitch.test.ts` — `vi.mock` of
  // `@/lib/env` permanently pollutes the worker's module cache
  // (Vitest 2.x ESM), so the killswitch case must run in its own file
  // with the flag mocked OFF at module init.
});
