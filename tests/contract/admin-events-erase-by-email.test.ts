/**
 * F6 remediation PR 2.2 / P4 — Contract test:
 *   POST /api/admin/events/erasure  (by-email cross-event bulk erasure)
 *
 * The DESTRUCTIVE PII surface that fans an admin data-subject-request out
 * across every event registration sharing an email. Verifies the route-level
 * RBAC grid (FR-035), body validation, the tally-shape response (incl.
 * `truncated`), the email normalisation (trim + lower, carry-forward #4), and
 * — the review carry-forward the whole surface hinges on — that a backend
 * enumerate-THROW is caught and mapped to a clean 500 rather than escaping as
 * an unhandled rejection (carry-forward #2).
 *
 * Mocks at the module boundary so no DB / Upstash / audit emit is hit. Mirrors
 * the shipped per-registration `admin-registration-erase-api.test.ts`.
 *
 * Kill-switch coverage lives in the sibling
 * `admin-events-erase-by-email-killswitch.test.ts` — `vi.mock('@/lib/env')`
 * permanently pollutes the worker's module cache (Vitest 2.x ESM), so the
 * flag-OFF case must run in its own file with the flag mocked off at init.
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

const runEraseAttendeesByEmailMock = vi.fn();
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
    runEraseAttendeesByEmail: (...args: unknown[]) =>
      runEraseAttendeesByEmailMock(...args),
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
const ADMIN_USER_ID = '00000000-0000-4000-8000-000000000001';
const ROUTE_URL = 'http://test/api/admin/events/erasure';

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
  return (await import('@/app/api/admin/events/erasure/route')) as {
    POST: (req: NextRequest) => Promise<Response>;
  };
}

function jsonRequest(body: unknown): NextRequest {
  return new NextRequest(ROUTE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
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

describe('PR 2.2 — POST /api/admin/events/erasure (by-email bulk erasure)', () => {
  vi.setConfig({ testTimeout: 60_000 });

  describe('200 OK — tally shape', () => {
    it('returns 200 with erased/alreadyErased/failed + truncated', async () => {
      runEraseAttendeesByEmailMock.mockResolvedValue({
        ok: true,
        value: {
          erasedCount: 2,
          alreadyErasedCount: 0,
          failedCount: 0,
          truncated: false,
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({
          email: 'subject@example.com',
          reasonText: 'GDPR Art. 17 request',
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        erasedCount: 2,
        alreadyErasedCount: 0,
        failedCount: 0,
        truncated: false,
      });
      // carry-forward #4 — the backend MUST receive the trim+lowered email.
      expect(runEraseAttendeesByEmailMock).toHaveBeenCalledWith(
        TENANT_SLUG,
        expect.objectContaining({
          emailLower: 'subject@example.com',
          actorUserId: ADMIN_USER_ID,
          reasonText: 'GDPR Art. 17 request',
        }),
      );
    });

    it('surfaces truncated=true (capped, incomplete pass) — carry-forward #3', async () => {
      runEraseAttendeesByEmailMock.mockResolvedValue({
        ok: true,
        value: {
          erasedCount: 500,
          alreadyErasedCount: 0,
          failedCount: 0,
          truncated: true,
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'subject@example.com', reasonText: 'x' }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['truncated']).toBe(true);
    });

    it('surfaces failedCount>0 (best-effort partial) — carry-forward #3', async () => {
      runEraseAttendeesByEmailMock.mockResolvedValue({
        ok: true,
        value: {
          erasedCount: 3,
          alreadyErasedCount: 0,
          failedCount: 2,
          truncated: false,
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'subject@example.com', reasonText: 'x' }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['failedCount']).toBe(2);
    });

    it('normalises the email — trims whitespace + lowercases before dispatch (carry-forward #4)', async () => {
      runEraseAttendeesByEmailMock.mockResolvedValue({
        ok: true,
        value: {
          erasedCount: 1,
          alreadyErasedCount: 0,
          failedCount: 0,
          truncated: false,
        },
      });
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: '  SUBJECT@Example.COM  ', reasonText: 'x' }),
      );
      expect(res.status).toBe(200);
      expect(runEraseAttendeesByEmailMock).toHaveBeenCalledWith(
        TENANT_SLUG,
        expect.objectContaining({ emailLower: 'subject@example.com' }),
      );
    });
  });

  describe('400 validation errors', () => {
    it('400 on missing reasonText', async () => {
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({ email: 'a@b.com' }));
      expect(res.status).toBe(400);
      expect(runEraseAttendeesByEmailMock).not.toHaveBeenCalled();
    });

    it('400 on empty reasonText', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'a@b.com', reasonText: '' }),
      );
      expect(res.status).toBe(400);
    });

    it('400 on reasonText exceeding 500 chars', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'a@b.com', reasonText: 'x'.repeat(501) }),
      );
      expect(res.status).toBe(400);
    });

    it('400 on malformed email (not RFC)', async () => {
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'not-an-email', reasonText: 'x' }),
      );
      expect(res.status).toBe(400);
      expect(runEraseAttendeesByEmailMock).not.toHaveBeenCalled();
    });

    it('400 on missing email', async () => {
      const { POST } = await loadRoute();
      const res = await POST(jsonRequest({ reasonText: 'x' }));
      expect(res.status).toBe(400);
    });

    it('400 on email exceeding 254 chars', async () => {
      const { POST } = await loadRoute();
      const oversized = `${'a'.repeat(250)}@b.com`;
      const res = await POST(
        jsonRequest({ email: oversized, reasonText: 'x' }),
      );
      expect(res.status).toBe(400);
    });

    it('400 on malformed JSON body', async () => {
      const { POST } = await loadRoute();
      const req = new NextRequest(ROUTE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not valid json',
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });
  });

  describe('RBAC matrix (FR-035) — carry-forward #1', () => {
    it('403 + role_violation_blocked audit when manager attempts erase', async () => {
      getCurrentSessionMock.mockResolvedValue(MANAGER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'a@b.com', reasonText: 'x' }),
      );
      expect(res.status).toBe(403);
      const violation = emitStandaloneMock.mock.calls.find(
        (c) =>
          (c[0] as Record<string, unknown>)['eventType'] ===
          'role_violation_blocked',
      );
      expect(violation).toBeDefined();
      expect(runEraseAttendeesByEmailMock).not.toHaveBeenCalled();
    });

    it('404 when member attempts erase', async () => {
      getCurrentSessionMock.mockResolvedValue(MEMBER_SESSION);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'a@b.com', reasonText: 'x' }),
      );
      expect(res.status).toBe(404);
    });

    it('404 when no session', async () => {
      getCurrentSessionMock.mockResolvedValue(null);
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'a@b.com', reasonText: 'x' }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('enumerate-throw → clean 500 (carry-forward #2)', () => {
    it('returns 500 (not an unhandled rejection) when the backend rejects', async () => {
      // The `list` step in the bulk fan-out fails LOUD (throws) on a repo
      // error — `runEraseAttendeesByEmail` rejects. The route MUST catch it
      // and map to a clean 500 rather than let it escape.
      runEraseAttendeesByEmailMock.mockRejectedValue(
        new Error('findByEmailLower failed: registrations_repo_error'),
      );
      const { POST } = await loadRoute();
      const res = await POST(
        jsonRequest({ email: 'a@b.com', reasonText: 'x' }),
      );
      expect(res.status).toBe(500);
    });
  });
});
