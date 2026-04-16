/**
 * T127 — Contract test: GET /api/members/[memberId]/timeline (US6).
 *
 * Mocks `requireAdminContext`, `buildMembersDeps`, the tenant resolver,
 * and the `timelineList` use case so the handler runs without touching
 * the real DB / session. Asserts the response shape + HTTP status for
 * each branch of the route handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const timelineListMock = vi.fn();
const buildMembersDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: (...args: unknown[]) => buildMembersDepsMock(...args),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    timelineList: (...args: unknown[]) => timelineListMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
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
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

const validMemberId = '00000000-0000-4000-8000-000000000001';

function makeRequest(url: string): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

describe('contract: GET /api/members/[memberId]/timeline (T127)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 happy path — returns items + next_cursor', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, timeline: {} });
    timelineListMock.mockResolvedValueOnce(
      ok({
        memberId: validMemberId,
        events: [
          {
            id: 'aud-1',
            timestamp: new Date('2026-04-10T10:00:00Z'),
            eventType: 'member_created',
            actorUserId: 'admin-1',
            actorDisplayName: 'Admin One',
            payload: { member_id: validMemberId },
          },
        ],
        nextCursor: null,
        total: 1,
      }),
    );
    const { GET } = await import(
      '@/app/api/members/[memberId]/timeline/route'
    );
    const res = await GET(
      makeRequest(
        `http://localhost/api/members/${validMemberId}/timeline?limit=50`,
      ),
      { params: Promise.resolve({ memberId: validMemberId }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items[0].id).toBe('aud-1');
    expect(body.items[0].event_type).toBe('member_created');
    expect(body.items[0].timestamp).toBe('2026-04-10T10:00:00.000Z');
    expect(body.items[0].actor_display_name).toBe('Admin One');
    expect(body.next_cursor).toBeNull();
    expect(body.total).toBe(1);
  });

  it('404 not_found — invalid memberId param (non-UUID)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, timeline: {} });
    const { GET } = await import(
      '@/app/api/members/[memberId]/timeline/route'
    );
    const res = await GET(
      makeRequest('http://localhost/api/members/not-a-uuid/timeline'),
      { params: Promise.resolve({ memberId: 'not-a-uuid' }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('404 not_found — use case returns not_found (cross-tenant probe)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, timeline: {} });
    timelineListMock.mockResolvedValueOnce(
      err({ type: 'not_found', message: 'Member not found' }),
    );
    const { GET } = await import(
      '@/app/api/members/[memberId]/timeline/route'
    );
    const res = await GET(
      makeRequest(
        `http://localhost/api/members/${validMemberId}/timeline`,
      ),
      { params: Promise.resolve({ memberId: validMemberId }) },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('400 validation_error — invalid limit query param', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, timeline: {} });
    const { GET } = await import(
      '@/app/api/members/[memberId]/timeline/route'
    );
    const res = await GET(
      makeRequest(
        `http://localhost/api/members/${validMemberId}/timeline?limit=999`,
      ),
      { params: Promise.resolve({ memberId: validMemberId }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('403 forbidden — non-admin rejected by requireAdminContext', async () => {
    const { NextResponse } = await import('next/server');
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { GET } = await import(
      '@/app/api/members/[memberId]/timeline/route'
    );
    const res = await GET(
      makeRequest(
        `http://localhost/api/members/${validMemberId}/timeline`,
      ),
      { params: Promise.resolve({ memberId: validMemberId }) },
    );
    expect(res.status).toBe(403);
  });

  it('500 internal — use case returns server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({ memberRepo: {}, timeline: {} });
    timelineListMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'DB outage' }),
    );
    const { GET } = await import(
      '@/app/api/members/[memberId]/timeline/route'
    );
    const res = await GET(
      makeRequest(
        `http://localhost/api/members/${validMemberId}/timeline`,
      ),
      { params: Promise.resolve({ memberId: validMemberId }) },
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('internal');
  });
});
