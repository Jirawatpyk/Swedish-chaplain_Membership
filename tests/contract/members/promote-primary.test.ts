/**
 * T071 partial — Contract test: POST /api/members/[memberId]/contacts/[contactId]/promote-primary.
 *
 * Verifies:
 *   - 200 returns `{ demoted, promoted }` envelope
 *   - 404 when use case says not_found
 *   - 409 when partial-index race surfaces as `conflict`
 *   - 500 on server error
 *   - 401 when session missing (admin-context short-circuit)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const promotePrimaryMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({})),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    promotePrimary: (...args: unknown[]) => promotePrimaryMock(...args),
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
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-pp',
};

const memberId = '11111111-2222-3333-4444-555555555555';
const oldPrimary = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const newPrimary = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

const baseContact = {
  tenantId: 'test',
  memberId,
  firstName: 'A',
  lastName: 'B',
  email: 'a@b.co',
  phone: null,
  roleTitle: null,
  preferredLanguage: 'en' as const,
  dateOfBirth: null,
  linkedUserId: null,
  removedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/members/${memberId}/contacts/${newPrimary}/promote-primary`,
    { method: 'POST' },
  );
}

const routeParams = async () => ({ memberId, contactId: newPrimary });

describe('contract: POST /promote-primary (T071)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 returns { demoted, promoted } envelope', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    promotePrimaryMock.mockResolvedValueOnce(
      ok({
        demoted: { ...baseContact, contactId: oldPrimary, isPrimary: false },
        promoted: { ...baseContact, contactId: newPrimary, isPrimary: true },
      }),
    );
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/promote-primary/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.demoted.contact_id).toBe(oldPrimary);
    expect(body.promoted.contact_id).toBe(newPrimary);
    expect(body.promoted.is_primary).toBe(true);
  });

  it('404 when use case reports not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    promotePrimaryMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/promote-primary/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(404);
  });

  it('409 on partial-index race (conflict)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    promotePrimaryMock.mockResolvedValueOnce(
      err({ type: 'conflict', reason: 'primary partial-index race' }),
    );
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/promote-primary/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
  });

  it('500 on server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    promotePrimaryMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'boom' }),
    );
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/promote-primary/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(500);
  });

  it('401 when session missing', async () => {
    const { NextResponse } = await import('next/server');
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/promote-primary/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(401);
  });
});
