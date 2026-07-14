/**
 * Contract test: GET /api/geo/postal/[code] (058 / PR-B, Task 3).
 *
 * Reference data, not tenant data — no tenant-context mock needed. Still
 * staff-guarded (mirrors `src/app/api/members/route.ts`), so the
 * admin-context gate is mocked the same way `tests/contract/members/
 * get-member.test.ts` does it: a rejection short-circuits to `{ response }`,
 * never a thrown error (see `src/lib/admin-context.ts`).
 *
 * `lookupPostalCode` itself is NOT mocked — it runs against the real,
 * checksum-pinned `data.json` so the 200/404 assertions double as a
 * lightweight end-to-end check of the route wiring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const requireAdminContextMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: requireAdminContextMock,
}));

const staffContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

function makeRequest(code: string): NextRequest {
  return new NextRequest(`http://localhost:3100/api/geo/postal/${code}`, {
    method: 'GET',
  });
}

describe('contract: GET /api/geo/postal/[code]', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 with candidates for a known code', async () => {
    requireAdminContextMock.mockResolvedValueOnce(staffContext);

    const { GET } = await import('@/app/api/geo/postal/[code]/route');
    const res = await GET(makeRequest('10110'), {
      params: Promise.resolve({ code: '10110' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.candidates).toHaveLength(9);
  });

  it('404 for an unknown code', async () => {
    requireAdminContextMock.mockResolvedValueOnce(staffContext);

    const { GET } = await import('@/app/api/geo/postal/[code]/route');
    const res = await GET(makeRequest('99999'), {
      params: Promise.resolve({ code: '99999' }),
    });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('postal_code_not_found');
  });

  it('400 for a malformed code', async () => {
    requireAdminContextMock.mockResolvedValueOnce(staffContext);

    const { GET } = await import('@/app/api/geo/postal/[code]/route');
    const res = await GET(makeRequest('abc'), {
      params: Promise.resolve({ code: 'abc' }),
    });

    expect(res.status).toBe(400);
  });

  it('401 when unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { GET } = await import('@/app/api/geo/postal/[code]/route');
    const res = await GET(makeRequest('10110'), {
      params: Promise.resolve({ code: '10110' }),
    });

    expect(res.status).toBe(401);
  });
});
