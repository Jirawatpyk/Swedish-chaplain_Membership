/**
 * Contract — POST /api/members/bulk (action: send_portal_invite) — go-live P1-17.
 *
 * Verifies the route routes send_portal_invite to `bulkSendPortalInvite` and
 * returns a 200 with the per-member buckets body even on partial success
 * (some skipped/failed), plus the shared route gates (idempotency, cap, RBAC,
 * rate limit). The all-or-nothing archive/change_plan path is covered by
 * bulk-action.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const requireAdminContextMock = vi.fn();
const bulkSendPortalInviteMock = vi.fn();
const rateLimitCheckMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
const auditRecordMock = vi.fn().mockResolvedValue({ ok: true, value: undefined });
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    tenant: { slug: 'test' },
    memberRepo: {},
    contactRepo: {},
    createUser: vi.fn(),
    audit: { record: auditRecordMock, recordInTx: auditRecordMock },
    plans: {},
    clock: { now: () => new Date() },
    idFactory: { memberId: () => 'id', contactId: () => 'id' },
  })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    bulkSendPortalInvite: (...args: unknown[]) => bulkSendPortalInviteMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } })),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
}));
vi.mock('@/modules/auth', async () => {
  const actual = await vi.importActual<typeof import('@/modules/auth')>('@/modules/auth');
  return {
    ...actual,
    rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
  };
});

const adminContext = {
  current: { user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' }, session: { id: 's1' } },
  sourceIp: '203.0.113.5',
  requestId: 'req-invite-1',
};
const forbiddenContext = {
  response: new (await import('next/server')).NextResponse(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
};

function makeRequest(body: unknown, headers: Record<string, string> = { 'idempotency-key': 'idem-invite' }): NextRequest {
  return new NextRequest('http://localhost/api/members/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function rlOk() {
  rateLimitCheckMock.mockResolvedValueOnce({ success: true, remaining: 9, reset: Date.now() + 600_000 });
}

describe('contract: POST /api/members/bulk send_portal_invite (P1-17)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 with per-member buckets body on partial success', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rlOk();
    bulkSendPortalInviteMock.mockResolvedValueOnce({
      ok: true,
      value: {
        invited: [{ memberId: 'm1', contactId: 'c1', userId: 'u1', email: 'm1@x.test' }],
        skipped: [{ memberId: 'm2', reason: 'already_linked' }],
        failed: [{ memberId: 'm3', code: 'email_taken' }],
        counts: { invited: 1, skipped: 1, failed: 1 },
      },
    });
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(makeRequest({ action: 'send_portal_invite', member_ids: ['m1', 'm2', 'm3'] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({ invited: 1, skipped: 1, failed: 1 });
    expect(body.invited).toEqual([{ member_id: 'm1', contact_id: 'c1', user_id: 'u1', email: 'm1@x.test' }]);
    expect(body.skipped).toEqual([{ member_id: 'm2', reason: 'already_linked' }]);
    expect(body.failed).toEqual([{ member_id: 'm3', code: 'email_taken' }]);
    expect(bulkSendPortalInviteMock).toHaveBeenCalledTimes(1);
  });

  it('400 when Idempotency-Key header is missing', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(makeRequest({ action: 'send_portal_invite', member_ids: ['m1'] }, {}));
    expect(res.status).toBe(400);
    expect(bulkSendPortalInviteMock).not.toHaveBeenCalled();
  });

  it('400 bulk_cap_exceeded for > 100 member_ids (route pre-check)', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const ids = Array.from({ length: 101 }, (_, i) => `m${i}`);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(makeRequest({ action: 'send_portal_invite', member_ids: ids }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_cap_exceeded');
    expect(bulkSendPortalInviteMock).not.toHaveBeenCalled();
  });

  it('403 for a non-admin actor', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(forbiddenContext);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(makeRequest({ action: 'send_portal_invite', member_ids: ['m1'] }));
    expect(res.status).toBe(403);
    expect(bulkSendPortalInviteMock).not.toHaveBeenCalled();
  });

  it('429 when rate-limited', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({ success: false, remaining: 0, reset: Date.now() + 600_000 });
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(makeRequest({ action: 'send_portal_invite', member_ids: ['m1'] }));
    expect(res.status).toBe(429);
    expect(bulkSendPortalInviteMock).not.toHaveBeenCalled();
  });
});
