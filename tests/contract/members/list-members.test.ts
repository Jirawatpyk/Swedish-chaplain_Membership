/**
 * T058 — Contract test: GET /api/members (US2).
 *
 * Mocks admin-context + directorySearch to assert the response envelope
 * (`items` + `next_cursor`) + query-param validation (400 on bad shape).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const directorySearchMock = vi.fn();

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
    directorySearch: (...args: unknown[]) => directorySearchMock(...args),
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
  requestId: 'req-l1',
};

function makeRequest(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/members${query}`, {
    method: 'GET',
  });
}

describe('contract: GET /api/members (T058)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 — returns { items, next_cursor } envelope', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    directorySearchMock.mockResolvedValueOnce(
      ok({
        items: [
          {
            member: {
              memberId: 'm-1',
              tenantId: 'test-swecham',
              companyName: 'Fogmaker',
              country: 'SE',
              planId: 'premium',
              planYear: 2026,
              status: 'active',
              lastActivityAt: new Date('2026-04-01T00:00:00Z'),
              taxId: null,
              legalEntityType: null,
              website: null,
              description: null,
              foundedYear: null,
              turnoverThb: null,
              registrationDate: new Date('2026-01-01'),
              registrationFeePaid: true,
              notes: null,
              archivedAt: null,
              createdAt: new Date('2026-01-01'),
              updatedAt: new Date('2026-01-01'),
            },
            primaryContact: {
              contactId: 'c-1',
              memberId: 'm-1',
              tenantId: 'test-swecham',
              firstName: 'Anna',
              lastName: 'A',
              email: 'anna@fogmaker.se',
              phone: null,
              roleTitle: null,
              preferredLanguage: 'sv',
              isPrimary: true,
              dateOfBirth: null,
              linkedUserId: null,
              removedAt: null,
              createdAt: new Date('2026-01-01'),
              updatedAt: new Date('2026-01-01'),
            },
          },
        ],
        nextCursor: 'cursor-abc',
      }),
    );
    const { GET } = await import('@/app/api/members/route');
    const res = await GET(makeRequest('?q=Fogma'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].member_id).toBe('m-1');
    expect(body.items[0].primary_contact.email).toBe('anna@fogmaker.se');
    expect(body.next_cursor).toBe('cursor-abc');
  });

  it('400 on invalid limit', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { GET } = await import('@/app/api/members/route');
    const res = await GET(makeRequest('?limit=999'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_query');
  });

  it('500 when use case errors', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    directorySearchMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'x' }),
    );
    const { GET } = await import('@/app/api/members/route');
    const res = await GET(makeRequest());
    expect(res.status).toBe(500);
  });
});
