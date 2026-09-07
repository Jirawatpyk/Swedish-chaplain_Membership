/**
 * 108 PR-C T082 (US5 / FR-040, FR-040a, FR-040b, FR-042; contract
 * broadcast-audience § 5) — `GET /api/broadcasts/recipient-count` (member
 * compose) and `GET /api/admin/broadcasts/recipient-count` (admin proxy
 * compose).
 *
 * Wire contract, resolver mocked at the barrel:
 *   - numbers only: `{ count, ceiling, exceeds, orphans, droppedByPreference }`
 *     — never an address, never a member or contact id (FR-040a);
 *   - the count is the resolver's estimate for the CALLER's member
 *     (`requestingMemberId`), phase `'submit'` (a count must not keep the
 *     dispatch-side opt-out metric series alive);
 *   - over the ceiling → `exceeds: true` with the TRUE count (FR-041, never
 *     truncated); empty → `count: 0`;
 *   - 400 on a malformed query; 401 from the member gate; 429 from the
 *     30/min (tenant, user) limiter, consumed BEFORE the resolve; 503
 *     `count_unavailable` when resolution fails (the client shows "count
 *     unavailable", never a stale number — FR-040b);
 *   - admin route: `broadcasts.write`, `member_id` required; an unknown /
 *     foreign member → 404 + `member_cross_tenant_probe` audit (Constitution
 *     I.4), the probe never leaking whether the id exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { err, ok } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const requireApiPermissionMock = vi.fn();
const resolveSegmentRecipientsMock = vi.fn();
const checkLimitMock = vi.fn();
const findByIdMock = vi.fn();
const auditRecordMock = vi.fn(async () => ok(undefined));

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/broadcasts', () => ({
  resolveSegmentRecipients: (...args: unknown[]) => resolveSegmentRecipientsMock(...args),
  makeResolveSegmentDeps: () => ({ tenant: { slug: 'test-tenant' }, audienceCeiling: 5000 }),
  broadcastsRateLimiter: { checkLimit: (...args: unknown[]) => checkLimitMock(...args) },
}));
vi.mock('@/modules/members', () => ({
  drizzleMemberRepo: { findById: (...args: unknown[]) => findByIdMock(...args) },
  asMemberId: (raw: string) => raw,
}));
vi.mock('@/lib/contact-marketing-deps', () => ({
  buildContactMarketingDeps: () => ({ audit: { record: auditRecordMock } }),
}));

const memberCtx = {
  current: {
    user: { id: 'user-member-1', email: 'member@swecham.test', role: 'member' as const, status: 'active' as const, displayName: 'Member' },
    session: { id: 'sess-m-1' },
  },
  tenant: { slug: 'test-tenant', __brand: true },
  member: { memberId: 'm-1', planId: 'p-prem' },
  memberId: 'm-1',
  ownContact: { contactId: 'c-1' },
  ownContactId: 'c-1',
  sourceIp: '203.0.113.10',
  requestId: 'req-count-1',
};

const adminCtx = {
  current: {
    user: { id: 'user-admin-1', email: 'admin@swecham.test', role: 'super_admin' as const, status: 'active' as const, displayName: 'Admin' },
    session: { id: 'sess-a-1' },
  },
  requestId: 'req-count-admin-1',
};

const okResolve = ok({
  recipients: ['a@example.com', 'b@example.com'],
  estimatedCount: 42,
  orphans: ['m-orphan'],
  droppedByPreference: 2,
});

function memberRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/broadcasts/recipient-count${query}`, { method: 'GET' });
}
function adminRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/admin/broadcasts/recipient-count${query}`, { method: 'GET' });
}
async function importMemberRoute() {
  return import('@/app/api/broadcasts/recipient-count/route');
}
async function importAdminRoute() {
  return import('@/app/api/admin/broadcasts/recipient-count/route');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  checkLimitMock.mockResolvedValue(ok(true));
  resolveSegmentRecipientsMock.mockResolvedValue(okResolve);
  findByIdMock.mockResolvedValue(ok({ memberId: 'm-9', companyName: 'Acme' }));
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/broadcasts/recipient-count (member) — 108 PR-C T082/T088', () => {
  it('200: numbers only — { count, ceiling, exceeds:false, orphans, droppedByPreference }; no address or id leaks', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest('?segment=all_members'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 42, ceiling: 5000, exceeds: false, orphans: 1, droppedByPreference: 2 });
    expect(JSON.stringify(body)).not.toMatch(/@|m-orphan|m-1/);
  });

  it('resolves for the CALLER as requestingMemberId, phase submit, and forwards tier codes', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { GET } = await importMemberRoute();
    await GET(memberRequest('?segment=tier&tier=corporate,partnership'));
    expect(resolveSegmentRecipientsMock).toHaveBeenCalledTimes(1);
    const [, input] = resolveSegmentRecipientsMock.mock.calls[0]!;
    expect(input).toEqual({
      segment: { kind: 'tier', tierCodes: ['corporate', 'partnership'] },
      phase: 'submit',
      requestingMemberId: 'm-1',
      customRecipients: null,
    });
  });

  it('over the ceiling → 200 with the TRUE count and exceeds:true (never truncated)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    resolveSegmentRecipientsMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_audience_too_large', count: 5001, cap: 5000 }),
    );
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest('?segment=all_members'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 5001, ceiling: 5000, exceeds: true, orphans: 0, droppedByPreference: 0 });
  });

  it('empty audience → 200 with count 0', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    resolveSegmentRecipientsMock.mockResolvedValueOnce(err({ kind: 'broadcast_empty_segment_blocked' }));
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest('?segment=event_attendees_last_90d'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 0, ceiling: 5000, exceeds: false, orphans: 0, droppedByPreference: 0 });
  });

  it.each([
    ['?segment=custom', 'custom lists are counted client-side'],
    ['?segment=tier', 'tier without codes'],
    ['?segment=nope', 'unknown segment'],
    ['', 'missing segment'],
  ])('400 invalid_query for %s (%s)', async (query) => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest(query));
    expect(res.status).toBe(400);
    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
  });

  it('401 when the member gate rejects — nothing else runs', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 }),
    });
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest('?segment=all_members'));
    expect(res.status).toBe(401);
    expect(checkLimitMock).not.toHaveBeenCalled();
    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
  });

  it('429 from the 30/min (tenant, user) limiter, consumed BEFORE the resolve, with Retry-After', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    checkLimitMock.mockResolvedValueOnce(
      err({ kind: 'rate_limit_exceeded', retryAfterSeconds: 17, key: 'k' }),
    );
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest('?segment=all_members'));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:count:test-tenant:user-member-1', 30, 60);
    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
  });

  it('503 count_unavailable when the resolver reports a server error — never a stale number', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    resolveSegmentRecipientsMock.mockResolvedValueOnce(err({ kind: 'resolve.server_error', message: 'neon down' }));
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest('?segment=all_members'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('count_unavailable');
    expect(JSON.stringify(body)).not.toContain('neon down');
  });

  it('503 count_unavailable when the resolver throws (the opt-out lookup is fail-closed by design)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    resolveSegmentRecipientsMock.mockRejectedValueOnce(new Error('contacts lookup down'));
    const { GET } = await importMemberRoute();
    const res = await GET(memberRequest('?segment=all_members'));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('count_unavailable');
  });
});

describe('GET /api/admin/broadcasts/recipient-count (admin proxy) — 108 PR-C T082/T088', () => {
  it('200 happy (super_admin): counts for the proxied member as requestingMemberId; numbers only', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminCtx);
    const { GET } = await importAdminRoute();
    const res = await GET(adminRequest('?member_id=11111111-1111-4111-8111-111111111111&segment=all_members'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 42, ceiling: 5000, exceeds: false, orphans: 1, droppedByPreference: 2 });
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'broadcasts.write');
    const [, input] = resolveSegmentRecipientsMock.mock.calls[0]!;
    expect(input).toMatchObject({ requestingMemberId: '11111111-1111-4111-8111-111111111111', phase: 'submit' });
  });

  it('404 + member_cross_tenant_probe audit for an unknown or foreign member_id; the resolver never runs', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminCtx);
    findByIdMock.mockResolvedValueOnce(err({ code: 'repo.not_found' }));
    const { GET } = await importAdminRoute();
    const res = await GET(adminRequest('?member_id=22222222-2222-4222-8222-222222222222&segment=all_members'));
    expect(res.status).toBe(404);
    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
    expect(auditRecordMock).toHaveBeenCalledTimes(1);
    const [, event] = auditRecordMock.mock.calls[0] as unknown as [unknown, { type: string; actorUserId: string; payload: Record<string, unknown> }];
    expect(event.type).toBe('member_cross_tenant_probe');
    expect(event.actorUserId).toBe('user-admin-1');
    expect(event.payload).toMatchObject({ attempted_member_id: '22222222-2222-4222-8222-222222222222' });
  });

  it('503 count_unavailable when the member lookup FAILS (repo.unexpected) — no probe audit, no resolve (review H-1)', async () => {
    // A Neon timeout / RLS hiccup on `findById` is NOT a cross-tenant probe.
    // Before this case the route branched on `!lookup.ok` alone, so an
    // outage wrote `member_cross_tenant_probe` rows into the append-only
    // audit log about members that exist, and answered "not found".
    requireApiPermissionMock.mockResolvedValueOnce(adminCtx);
    findByIdMock.mockResolvedValueOnce(
      err({ code: 'repo.unexpected', cause: new Error('neon: statement timeout') }),
    );
    const { GET } = await importAdminRoute();
    const res = await GET(adminRequest('?member_id=22222222-2222-4222-8222-222222222222&segment=all_members'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('count_unavailable');
    expect(auditRecordMock).not.toHaveBeenCalled();
    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).not.toMatch(/statement timeout|neon/);
  });

  it('400 when member_id is missing or not a uuid', async () => {
    requireApiPermissionMock.mockResolvedValue(adminCtx);
    const { GET } = await importAdminRoute();
    expect((await GET(adminRequest('?segment=all_members'))).status).toBe(400);
    expect((await GET(adminRequest('?member_id=nope&segment=all_members'))).status).toBe(400);
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  it('403 / 401 come from the permission gate untouched', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 }),
    });
    const { GET } = await importAdminRoute();
    const res = await GET(adminRequest('?member_id=11111111-1111-4111-8111-111111111111&segment=all_members'));
    expect(res.status).toBe(403);
    expect(resolveSegmentRecipientsMock).not.toHaveBeenCalled();
  });

  it('429 from the limiter keyed by (tenant, admin user), before any read', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminCtx);
    checkLimitMock.mockResolvedValueOnce(err({ kind: 'rate_limit_exceeded', retryAfterSeconds: 5, key: 'k' }));
    const { GET } = await importAdminRoute();
    const res = await GET(adminRequest('?member_id=11111111-1111-4111-8111-111111111111&segment=all_members'));
    expect(res.status).toBe(429);
    expect(checkLimitMock).toHaveBeenCalledWith('broadcasts:count:test-tenant:user-admin-1', 30, 60);
    expect(findByIdMock).not.toHaveBeenCalled();
  });
});
