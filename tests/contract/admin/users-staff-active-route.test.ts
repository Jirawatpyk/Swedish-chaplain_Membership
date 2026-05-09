/**
 * F8 Phase 8 R10 W3 close — contract test for
 * `GET /api/admin/users/staff-active`.
 *
 * Pins:
 *   - 401 when session resolution throws (DB outage / Upstash quota /
 *     non-NEXT_REDIRECT) — distinct from a routine unauth that returns
 *     a NEXT_REDIRECT and is filtered out at the helper.
 *   - 401 when `requireSession` redirects (NEXT_REDIRECT path).
 *   - 403 when caller is `member` (only admin/manager allowed).
 *   - 200 with `{users:[{id,email,display_name,role}, …]}` — payload
 *     merged from the two parallel `listWithFilter` calls (admin +
 *     manager). Confirms snake_case `display_name` mapping (S6 close
 *     bonus — `displayName ?? null`).
 *   - 500 when `userRepo.listWithFilter` throws (Promise.all rejection).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireSessionMock = vi.fn();
const listWithFilterMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  requireSession: (...args: unknown[]) => requireSessionMock(...args),
}));
vi.mock('@/lib/auth-deps', () => ({
  userRepo: {
    listWithFilter: (...args: unknown[]) => listWithFilterMock(...args),
  },
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

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/users/staff-active — contract (R10 W3)', () => {
  it(
    'returns 401 when requireSession throws non-redirect (e.g. Upstash outage)',
    { timeout: 30_000 },
    async () => {
      requireSessionMock.mockRejectedValueOnce(new Error('upstash-down'));
      const GET = await loadHandler();
      const res = await GET(makeReq());
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe('unauthenticated');
    },
  );

  it('returns 401 when requireSession redirects (NEXT_REDIRECT) — no Sentry log noise', async () => {
    const redirectErr = Object.assign(new Error('redirect'), {
      digest: 'NEXT_REDIRECT;replace;/sign-in;303',
    });
    requireSessionMock.mockRejectedValueOnce(redirectErr);
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  it('returns 403 when role is member', async () => {
    requireSessionMock.mockResolvedValueOnce({
      user: { id: 'm-1', email: 'm@x.co', role: 'member', status: 'active' },
      session: { id: 's' },
    });
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });

  it('returns 200 with merged admin+manager users (snake_case)', async () => {
    requireSessionMock.mockResolvedValueOnce({
      user: { id: 'a-1', email: 'a@x.co', role: 'admin', status: 'active' },
      session: { id: 's' },
    });
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
    // R10 S6 close — Promise.all parallel; the route invokes
    // listWithFilter twice (admin + manager). Sequence the mock returns.
    listWithFilterMock
      .mockResolvedValueOnce(adminUsers)
      .mockResolvedValueOnce(managerUsers);

    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.users)).toBe(true);
    expect(body.users).toHaveLength(2);
    expect(body.users[0]).toEqual({
      id: 'admin-1',
      email: 'admin1@x.co',
      display_name: 'Admin One',
      role: 'admin',
    });
    expect(body.users[1]).toEqual({
      id: 'manager-1',
      email: 'manager1@x.co',
      display_name: null,
      role: 'manager',
    });
    // Confirm both queries were dispatched (parallel via Promise.all).
    expect(listWithFilterMock).toHaveBeenCalledTimes(2);
    expect(listWithFilterMock).toHaveBeenNthCalledWith(
      1,
      { role: 'admin', status: 'active' },
      100,
      0,
    );
    expect(listWithFilterMock).toHaveBeenNthCalledWith(
      2,
      { role: 'manager', status: 'active' },
      100,
      0,
    );
  });

  it('returns Cache-Control: no-store, private + correlation header', async () => {
    requireSessionMock.mockResolvedValueOnce({
      user: { id: 'a-1', email: 'a@x.co', role: 'admin', status: 'active' },
      session: { id: 's' },
    });
    listWithFilterMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect(res.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('returns 500 when listWithFilter throws (DB outage)', async () => {
    requireSessionMock.mockResolvedValueOnce({
      user: { id: 'a-1', email: 'a@x.co', role: 'admin', status: 'active' },
      session: { id: 's' },
    });
    listWithFilterMock.mockRejectedValueOnce(new Error('neon-down'));
    const GET = await loadHandler();
    const res = await GET(makeReq());
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe('server_error');
  });
});
