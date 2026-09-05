/**
 * 108 T041 review round 4 (F4-#1) — Contract test:
 * DELETE /api/members/[memberId]/contacts/[contactId].
 *
 * The DELETE route had no contract coverage at all — which is how three review
 * rounds missed that the two NEW conflict outcomes `removeContact` returns since
 * PR-B (`no_primary_contact` / `primary_contact_race`, from the in-tx policy and
 * from migration 0293's deferred trigger at COMMIT) fell through to `default`
 * and answered 500 for a rule the UI can explain.
 *
 * Verifies:
 *   - 200 returns the serialised (soft-removed) contact
 *   - 404 not_found
 *   - 409 cannot_remove_primary (FR-011)
 *   - 409 conflict with the machine reason in `details.reason` — never a 500
 *   - 500 server_error
 *   - 401 auth gate pass-through
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const removeContactMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
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
    removeContact: (...args: unknown[]) => removeContactMock(...args),
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
  requestId: 'req-rc',
};

const memberId = '11111111-2222-3333-4444-555555555555';
const contactId = 'aaaaaaaa-bbbb-cccc-dddd-333333333333';

const removed = {
  tenantId: 'test',
  contactId,
  memberId,
  firstName: 'A',
  lastName: 'B',
  email: 'a@b.co',
  phone: null,
  roleTitle: null,
  preferredLanguage: 'en' as const,
  isPrimary: false,
  dateOfBirth: null,
  linkedUserId: null,
  removedAt: new Date('2026-09-05T00:00:00Z'),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const ROUTE = '@/app/api/members/[memberId]/contacts/[contactId]/route';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/members/${memberId}/contacts/${contactId}`,
    { method: 'DELETE' },
  );
}

const routeParams = async () => ({ memberId, contactId });

describe('contract: DELETE /contacts/[contactId] (108 round 4)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 returns the serialised removed contact', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    removeContactMock.mockResolvedValueOnce(ok(removed));
    const { DELETE } = await import(ROUTE);
    const res = await DELETE(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.contact_id).toBe(contactId);
  });

  it('404 when the use case reports not_found', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    removeContactMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const { DELETE } = await import(ROUTE);
    const res = await DELETE(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(404);
  });

  it('409 cannot_remove_primary — FR-011', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    removeContactMock.mockResolvedValueOnce(err({ type: 'cannot_remove_primary' }));
    const { DELETE } = await import(ROUTE);
    const res = await DELETE(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('cannot_remove_primary');
  });

  it.each(['no_primary_contact', 'primary_contact_race'] as const)(
    '409 conflict{%s} carries the machine reason — never a 500 (F4-#1)',
    async (reason) => {
      requireApiPermissionMock.mockResolvedValueOnce(adminContext);
      removeContactMock.mockResolvedValueOnce(err({ type: 'conflict', reason }));
      const { DELETE } = await import(ROUTE);
      const res = await DELETE(makeRequest(), { params: routeParams() });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('conflict');
      expect(body.error.details.reason).toBe(reason);
    },
  );

  it('500 on server_error', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    removeContactMock.mockResolvedValueOnce(err({ type: 'server_error', message: 'boom' }));
    const { DELETE } = await import(ROUTE);
    const res = await DELETE(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(500);
  });

  it('401 when session missing', async () => {
    const { NextResponse } = await import('next/server');
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { DELETE } = await import(ROUTE);
    const res = await DELETE(makeRequest(), { params: routeParams() });
    expect(res.status).toBe(401);
  });
});
