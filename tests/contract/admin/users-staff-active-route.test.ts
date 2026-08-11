/**
 * F8 Phase 8 R10 W3 close — contract test for
 * `GET /api/admin/users/staff-active`.
 *
 * 016 T028: the route's session+role prologue folded into
 * `requireApiPermission(request, 'renewals.read', legacyAdminOrManager)`.
 * This test mocks ONLY the session source (`getCurrentSession`) and lets the
 * REAL gate + Domain evaluator decide, so the pinned matrix below is the
 * actual policy code end-to-end:
 *
 *   - 401 `{error:'no-session'}` for anonymous (pre-sweep shape was the F8
 *     `unauthenticated` envelope; consumer branches on `res.ok` only).
 *   - 500 when the session lookup throws (pre-sweep this surfaced as a
 *     generic 401 — an outage is now distinguishable from unauth).
 *   - 403 member AND 403 marketing (D16: unknown/new roles never escalate).
 *   - manager allowed (admin-or-manager read surface), super_admin allowed
 *     (D16 super_admin → admin on the legacy leg).
 *   - 200 with `{users:[{id,email,display_name,role}, …]}` — merged from the
 *     two parallel `listWithFilter` calls; snake_case mapping.
 *   - 500 when `userRepo.listWithFilter` throws (Promise.all rejection).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getCurrentSessionMock = vi.fn();
const listWithFilterMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));
vi.mock('@/lib/auth-deps', () => ({
  userRepo: {
    listWithFilter: (...args: unknown[]) => listWithFilterMock(...args),
  },
}));
// The gate's denial trail appends via a dynamic import of the audit repo;
// stub it so the deny cases never touch the placeholder-env db client.
vi.mock('@/modules/auth/infrastructure/db/audit-repo', () => ({
  auditRepo: { append: vi.fn(async () => {}) },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeReq(): NextRequest {
  return new NextRequest('http://localhost/api/admin/users/staff-active', {
    method: 'GET',
  });
}

async function loadHandler() {
  const mod = await import('@/app/api/admin/users/staff-active/route');
  return mod.GET;
}

function session(role: string) {
  return {
    user: { id: 'u-1', email: 'u@x.co', role, status: 'active' },
    session: { id: 's' },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/users/staff-active — contract (R10 W3 / 016 T028)', () => {
  it('returns 401 no-session for anonymous callers', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('no-session');
  });

  it('returns 500 when the session lookup throws (e.g. Upstash outage) — not a fake 401', async () => {
    getCurrentSessionMock.mockRejectedValueOnce(new Error('upstash-down'));
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('server-error');
  });

  it('returns 403 when role is member', async () => {
    getCurrentSessionMock.mockResolvedValue(session('member'));
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('forbidden');
    expect(listWithFilterMock).not.toHaveBeenCalled();
  });

  it('returns 403 for marketing (D16 — a role outside the observed set never escalates)', async () => {
    getCurrentSessionMock.mockResolvedValue(session('marketing'));
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    expect(listWithFilterMock).not.toHaveBeenCalled();
  });

  it('admits manager (read surface) — 200', async () => {
    getCurrentSessionMock.mockResolvedValue(session('manager'));
    listWithFilterMock.mockResolvedValue([]);
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it('admits super_admin via D16 (evaluates as admin on the legacy leg) — 200', async () => {
    getCurrentSessionMock.mockResolvedValue(session('super_admin'));
    listWithFilterMock.mockResolvedValue([]);
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
  });

  it('returns 200 with merged super_admin+admin+manager users (snake_case)', async () => {
    getCurrentSessionMock.mockResolvedValue(session('admin'));
    const superAdminUsers = [
      {
        id: 'sa-1',
        email: 'sa1@x.co',
        displayName: 'Super Admin',
        role: 'super_admin',
      },
    ];
    const adminUsers = [
      {
        id: 'admin-1',
        email: 'admin1@x.co',
        displayName: 'Admin One',
        role: 'admin',
      },
    ];
    const managerUsers = [
      {
        id: 'manager-1',
        email: 'manager1@x.co',
        displayName: null,
        role: 'manager',
      },
    ];
    // R10 S6 close — Promise.all parallel; 016 T030 (cutover defect 2) added
    // the super_admin query so promoted administrators stay in the picker.
    listWithFilterMock
      .mockResolvedValueOnce(superAdminUsers)
      .mockResolvedValueOnce(adminUsers)
      .mockResolvedValueOnce(managerUsers);

    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users).toHaveLength(3);
    expect(body.users[0]).toEqual({
      id: 'sa-1',
      email: 'sa1@x.co',
      display_name: 'Super Admin',
      role: 'super_admin',
    });
    expect(body.users[1]).toEqual({
      id: 'admin-1',
      email: 'admin1@x.co',
      display_name: 'Admin One',
      role: 'admin',
    });
    expect(body.users[2]).toEqual({
      id: 'manager-1',
      email: 'manager1@x.co',
      display_name: null,
      role: 'manager',
    });
    // Confirm all three queries were dispatched (parallel via Promise.all).
    expect(listWithFilterMock).toHaveBeenCalledTimes(3);
    expect(listWithFilterMock).toHaveBeenNthCalledWith(
      1,
      { role: 'super_admin', status: 'active' },
      100,
      0,
    );
    expect(listWithFilterMock).toHaveBeenNthCalledWith(
      2,
      { role: 'admin', status: 'active' },
      100,
      0,
    );
    expect(listWithFilterMock).toHaveBeenNthCalledWith(
      3,
      { role: 'manager', status: 'active' },
      100,
      0,
    );
  });

  it('returns Cache-Control: no-store, private + correlation header', async () => {
    getCurrentSessionMock.mockResolvedValue(session('admin'));
    listWithFilterMock.mockResolvedValue([]);
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('returns 500 when listWithFilter throws (DB outage)', async () => {
    getCurrentSessionMock.mockResolvedValue(session('admin'));
    listWithFilterMock.mockRejectedValueOnce(new Error('neon-down'));
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });
});
