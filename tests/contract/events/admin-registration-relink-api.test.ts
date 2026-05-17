/**
 * Phase B B8 — Contract test: POST /api/admin/events/[eventId]/registrations/[registrationId]/relink
 *
 * Closes test-coverage gap C2 (FR-014 + pseudonymised-row 409 path).
 * Mirrors `admin-registration-erase-api.test.ts` (B7) structure.
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

const runRelinkRegistrationMock = vi.fn();
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
    runRelinkRegistration: (...args: unknown[]) =>
      runRelinkRegistrationMock(...args),
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
const VALID_NEW_MEMBER_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const VALID_PATH = `http://test/api/admin/events/${VALID_EVENT_ID}/registrations/${VALID_REGISTRATION_ID}/relink`;
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
    '@/app/api/admin/events/[eventId]/registrations/[registrationId]/relink/route'
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

describe('Phase B B8 — POST /api/admin/events/[eventId]/registrations/[registrationId]/relink', () => {
  vi.setConfig({ testTimeout: 60_000 });

  describe('200 OK — happy path', () => {
    it('returns 200 with noop=false + newMatchedMemberId on success', async () => {
      runRelinkRegistrationMock.mockResolvedValue({
        ok: true,
        value: {
          noop: false,
          registrationId: VALID_REGISTRATION_ID,
          previousMatchedMemberId: 'old-member-uuid',
          newMatchedMemberId: VALID_NEW_MEMBER_ID,
          previousMatchType: 'member_contact',
          newMatchType: 'member_contact',
          quotaImpact: { partnership: 0, cultural: 0 },
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['noop']).toBe(false);
      expect(body['newMatchedMemberId']).toBe(VALID_NEW_MEMBER_ID);
    });

    it('returns 200 with noop=true for A→A short-circuit', async () => {
      runRelinkRegistrationMock.mockResolvedValue({
        ok: true,
        value: {
          noop: true,
          registrationId: VALID_REGISTRATION_ID,
          matchedMemberId: VALID_NEW_MEMBER_ID,
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['noop']).toBe(true);
    });
  });

  describe('400 validation errors', () => {
    it('400 on missing newMatchedMemberId', async () => {
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({}), withParams(VALID_PARAMS));
      expect(res.status).toBe(400);
    });

    it('400 on non-v4 UUID newMatchedMemberId', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: 'not-a-uuid' }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(400);
    });

    it('400 on malformed JSON', async () => {
      const { POST } = await loadRoute();
      const req = new NextRequest(VALID_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ broken',
      });
      const res = await POST(req, withParams(VALID_PARAMS));
      expect(res.status).toBe(400);
    });
  });

  describe('FR-014 — pseudonymised-row block', () => {
    it('409 when use-case returns pseudonymised_row_rejected', async () => {
      runRelinkRegistrationMock.mockResolvedValue({
        ok: false,
        error: {
          kind: 'pseudonymised_row_rejected',
          message: 'pseudonymised',
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(409);
    });

    it('409 when event already archived', async () => {
      runRelinkRegistrationMock.mockResolvedValue({
        ok: false,
        error: { kind: 'event_archived', message: 'archived' },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(409);
    });
  });

  describe('RBAC matrix (FR-035)', () => {
    it('403 + role_violation when manager attempts relink', async () => {
      getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(403);
      const violation = emitStandaloneMock.mock.calls.find(
        (c) =>
          (c[0] as Record<string, unknown>)['eventType'] ===
          'role_violation_blocked',
      );
      expect(violation).toBeDefined();
    });

    it('404 when member attempts relink', async () => {
      getCurrentSessionMock.mockResolvedValue(MEMBER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(404);
    });

    it('404 when no session', async () => {
      getCurrentSessionMock.mockResolvedValue(null);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('404 path-param rejection', () => {
    it('404 on non-v4 UUID eventId', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams({
          eventId: '11111111-2222-3333-4444-555555555555', // v3-ish
          registrationId: VALID_REGISTRATION_ID,
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('use-case error mapping', () => {
    it('404 on registration_not_found', async () => {
      runRelinkRegistrationMock.mockResolvedValue({
        ok: false,
        error: { kind: 'registration_not_found', message: 'no row' },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(404);
    });

    it('500 on generic audit error', async () => {
      runRelinkRegistrationMock.mockResolvedValue({
        ok: false,
        error: { kind: 'audit_emit_failed', message: 'audit fail' },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ newMatchedMemberId: VALID_NEW_MEMBER_ID }),
        withParams(VALID_PARAMS),
      );
      expect(res.status).toBe(500);
    });
  });
});
