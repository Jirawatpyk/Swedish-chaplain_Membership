/**
 * T071 partial — Contract test: GET /api/plans/[year]/[planId]/affected-members (US3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const affectedMembersCountMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({ plans: {} })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    affectedMembersCount: (...args: unknown[]) => affectedMembersCountMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 's1' },
  },
  sourceIp: '1.1.1.1',
  requestId: 'req-a1',
};

function makeRequest(year = '2026', planId = 'regular'): NextRequest {
  return new NextRequest(
    `http://localhost/api/plans/${year}/${planId}/affected-members`,
    { method: 'GET' },
  );
}

describe('contract: GET /api/plans/[year]/[planId]/affected-members (T071)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 — returns { plan_id, plan_year, count }', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    affectedMembersCountMock.mockResolvedValueOnce(ok({ count: 47 }));
    const { GET } = await import(
      '@/app/api/plans/[year]/[planId]/affected-members/route'
    );
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ year: '2026', planId: 'regular' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plan_id).toBe('regular');
    expect(body.plan_year).toBe(2026);
    expect(body.count).toBe(47);
  });

  it('404 on invalid params', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { GET } = await import(
      '@/app/api/plans/[year]/[planId]/affected-members/route'
    );
    const res = await GET(makeRequest('abc'), {
      params: Promise.resolve({ year: 'abc', planId: 'regular' }),
    });
    expect(res.status).toBe(404);
  });

  it('500 on use case error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    affectedMembersCountMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'x' }),
    );
    const { GET } = await import(
      '@/app/api/plans/[year]/[planId]/affected-members/route'
    );
    const res = await GET(makeRequest(), {
      params: Promise.resolve({ year: '2026', planId: 'regular' }),
    });
    expect(res.status).toBe(500);
  });
});
