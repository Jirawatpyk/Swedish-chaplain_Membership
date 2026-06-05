/**
 * Unit: portal serialiseMember (via GET /api/portal/profile) emits member_number
 * WITHOUT breaking the redaction whitelist (tax_id / notes stay omitted).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const getMemberMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...a: unknown[]) => requireMemberContextMock(...a),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: {}, contactRepo: {}, audit: {} }),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return { ...actual, getMember: (...a: unknown[]) => getMemberMock(...a) };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const MEMBER_ID = '11111111-1111-1111-1111-111111111111';

const memberCtx = {
  tenant: { slug: 'test-swecham', __brand: true },
  memberId: MEMBER_ID,
  current: { user: { id: 'u1' } },
  requestId: 'req-portal-1',
};

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost:3100/api/portal/profile', { method: 'GET' });
}

const MEMBER = {
  memberId: MEMBER_ID,
  memberNumber: 42,
  companyName: 'Fogmaker AB',
  legalEntityType: 'limited',
  country: 'SE',
  taxId: 'SE-SECRET-9999', // MUST NOT appear in the portal payload
  website: null,
  description: null,
  planId: 'plan-1',
  planYear: 2026,
  registrationDate: new Date('2026-01-15T00:00:00.000Z'),
  registrationFeePaid: true,
  status: 'active',
  lastActivityAt: null,
  notes: 'INTERNAL ADMIN NOTE', // MUST NOT appear
  createdAt: new Date('2026-01-15T00:00:00.000Z'),
  updatedAt: new Date('2026-01-15T00:00:00.000Z'),
};

describe('portal GET /api/portal/profile serialiseMember', () => {
  afterEach(() => vi.clearAllMocks());

  it('emits member_number and preserves the redaction whitelist', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    getMemberMock.mockResolvedValueOnce(ok({ member: MEMBER, contacts: [] }));

    const { GET } = await import('@/app/api/portal/profile/route');
    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_number).toBe(42);
    // Redaction whitelist intact (design §8.3 — tax_id/notes deliberately absent).
    expect(body).not.toHaveProperty('tax_id');
    expect(body).not.toHaveProperty('notes');
  });
});
