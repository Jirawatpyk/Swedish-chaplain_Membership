/**
 * T095 — Contract test: POST /api/admin/broadcasts/proxy-submit.
 *
 * Wave 6 GREEN. Spec authority: contracts/broadcasts-api.md § 2.2.
 *
 * Q12 admin-on-behalf-of-member. Wraps proxySubmitBroadcast which
 * delegates to submitBroadcast with actorRole='admin_proxy'. Quota
 * bypass is verified at the use-case level; here we focus on wire
 * contract: zod input validation + envelope shape + error mapping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err, type Result } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const proxySubmitMock = vi.fn();
const resolveTenantDisplayNameMock = vi.fn(
  async (..._args: unknown[]) => 'Test Chamber',
);

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/broadcasts-route-helpers', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/broadcasts-route-helpers')
  >('@/lib/broadcasts-route-helpers');
  return {
    ...actual,
    resolveTenantDisplayName: (...args: unknown[]) =>
      resolveTenantDisplayNameMock(...args),
  };
});
vi.mock('@/modules/broadcasts', () => ({
  proxySubmitBroadcast: (...args: unknown[]) => proxySubmitMock(...args),
  makeProxySubmitBroadcastDeps: () => ({}),
}));
// DV-17 — the route resolves the proxied member's display name via the F3
// barrel to compose the Resend From ("<member> via <tenant>"). Mock it so
// the contract test never touches the live DB.
const findMemberByIdMock = vi.fn(
  async (
    ..._args: unknown[]
  ): Promise<Result<{ companyName: string }, { code: string }>> =>
    ok({ companyName: 'Acme Co' }),
);
vi.mock('@/modules/members', () => ({
  drizzleMemberRepo: {
    findById: (...args: unknown[]) => findMemberByIdMock(...args),
  },
  asMemberId: (raw: string) => raw,
}));

const VALID_MEMBER_ID = '33333333-3333-3333-3333-333333333333';
const NEW_BROADCAST_ID = '44444444-4444-4444-4444-444444444444';
const adminCtx = {
  current: {
    user: {
      id: 'user-admin-1',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Admin',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.10',
  requestId: 'req-px-1',
};

const VALID_BODY = {
  requestedByMemberId: VALID_MEMBER_ID,
  subject: 'Welcome to the chamber',
  bodyHtml: '<p>Hello</p>',
  bodySource: 'plain',
  segment: { kind: 'all_members' as const },
  scheduledFor: null,
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/broadcasts/proxy-submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function importRoute() {
  return import('@/app/api/admin/broadcasts/proxy-submit/route');
}

const submitOutput = {
  broadcastId: NEW_BROADCAST_ID,
  status: 'submitted' as const,
  submittedAt: new Date('2026-06-15T05:00:00Z'),
  estimatedRecipientCount: 42,
  reservedQuotaSlot: true as const,
  reviewSlaTargetHours: 48,
};

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
afterEach(() => vi.clearAllMocks());

describe('POST /api/admin/broadcasts/proxy-submit — Wave 6 GREEN (T095)', () => {
  it('200 happy: { broadcastId, status:submitted, submittedAt, estimatedRecipientCount, actorRole:admin_proxy }', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(ok(submitOutput));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      broadcastId: NEW_BROADCAST_ID,
      status: 'submitted',
      estimatedRecipientCount: 42,
      actorRole: 'admin_proxy',
      reservedQuotaSlot: true,
      reviewSlaTargetHours: 48,
    });
  });

  it('Q12 dual-actor: use-case receives proxiedMemberId + adminUserId', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(ok(submitOutput));
    const { POST } = await importRoute();
    await POST(makeRequest(VALID_BODY));
    const callArgs = proxySubmitMock.mock.calls[0]?.[1] as {
      proxiedMemberId: string;
      adminUserId: string;
    };
    expect(callArgs.proxiedMemberId).toBe(VALID_MEMBER_ID);
    expect(callArgs.adminUserId).toBe('user-admin-1');
  });

  it('DV-17 + #18: route resolves proxied member companyName → memberLookup.found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    findMemberByIdMock.mockResolvedValueOnce(ok({ companyName: 'Fogmaker International AB' }));
    proxySubmitMock.mockResolvedValueOnce(ok(submitOutput));
    const { POST } = await importRoute();
    await POST(makeRequest(VALID_BODY));
    // #18 — the single member read is threaded in via the discriminated
    // `memberLookup`; the `found` arm carries the DV-17 companyName.
    const callArgs = proxySubmitMock.mock.calls[0]?.[1] as {
      memberLookup:
        | { status: 'found'; companyName: string }
        | { status: 'not_found' }
        | { status: 'lookup_failed'; message: string };
    };
    expect(callArgs.memberLookup).toEqual({
      status: 'found',
      companyName: 'Fogmaker International AB',
    });
  });

  it('400 invalid_body: subject too long', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, subject: 'x'.repeat(201) }),
    );
    expect(res.status).toBe(400);
    expect(proxySubmitMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body: subject empty', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const res = await POST(makeRequest({ ...VALID_BODY, subject: '' }));
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: bodyHtml missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const { bodyHtml: _bh, ...rest } = VALID_BODY;
    const res = await POST(makeRequest(rest));
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: requestedByMemberId not uuid', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, requestedByMemberId: 'not-uuid' }),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: tier segment without tierCodes', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const res = await POST(
      makeRequest({ ...VALID_BODY, segment: { kind: 'tier' } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: custom segment > 100 emails', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { POST } = await importRoute();
    const emails = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    const res = await POST(
      makeRequest({ ...VALID_BODY, segment: { kind: 'custom', emails } }),
    );
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: malformed JSON', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const req = new NextRequest(
      'http://localhost/api/admin/broadcasts/proxy-submit',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not-json',
      },
    );
    const { POST } = await importRoute();
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('404 broadcast_member_not_found: use-case rejects unknown member', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_member_not_found', memberId: VALID_MEMBER_ID }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_member_not_found');
    expect(body.error.details.memberId).toBe(VALID_MEMBER_ID);
  });

  it('#18 route mapping: findById repo.not_found → memberLookup.not_found → 404', async () => {
    // Drive the route's findById→memberLookup translation (route.ts ~103-109)
    // through `findMemberByIdMock` rather than the use-case mock: a repo
    // `not_found` must become `memberLookup: { status: 'not_found' }`. The
    // use-case (mocked) then maps that input to broadcast_member_not_found.
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    findMemberByIdMock.mockResolvedValueOnce(err({ code: 'repo.not_found' }));
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_member_not_found', memberId: VALID_MEMBER_ID }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    const callArgs = proxySubmitMock.mock.calls[0]?.[1] as {
      memberLookup: { status: string };
    };
    expect(callArgs.memberLookup).toEqual({ status: 'not_found' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_member_not_found');
  });

  it('#18 route mapping: findById repo.unexpected → memberLookup.lookup_failed → 500', async () => {
    // The non-not_found repo error arm: any other repo error code must become
    // `memberLookup: { status: 'lookup_failed', message: <code> }`. The
    // use-case (mocked) maps that to submit.server_error → 500.
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    findMemberByIdMock.mockResolvedValueOnce(err({ code: 'repo.unexpected' }));
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'submit.server_error', message: 'lookup_failed' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    const callArgs = proxySubmitMock.mock.calls[0]?.[1] as {
      memberLookup: { status: string; message?: string };
    };
    expect(callArgs.memberLookup.status).toBe('lookup_failed');
    expect(callArgs.memberLookup.message).toBe('repo.unexpected');
    expect(res.status).toBe(500);
  });

  it('422 broadcast_member_halted_pending_review (admin cannot bypass halt)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(
      err({
        kind: 'broadcast_member_halted_pending_review',
        memberId: VALID_MEMBER_ID,
      }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_subject_too_long surfaced from use-case', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_subject_too_long', maxChars: 200, actualChars: 250 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('admin_proxy at full member quota → 422 broadcast_quota_blocked (T-10)', async () => {
    // T-10 — the proxied member's quota cap is ENFORCED; the use-case
    // surfaces broadcast_quota_blocked when at cap and the route maps it
    // to 422 (no admin bypass). Arranged via the file's existing
    // proxySubmit deps-mock at-cap return.
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_quota_blocked', used: 6, reserved: 0, cap: 6 }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error.code).toBe('broadcast_quota_blocked');
  });

  it('422 broadcast_body_unsafe_html surfaced from use-case', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_body_unsafe_html', strippedTags: ['script'] }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('422 broadcast_empty_segment_blocked', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'broadcast_empty_segment_blocked' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(422);
  });

  it('401 unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(401);
  });

  it('403 manager attempting proxy-submit (forbidden)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(403);
  });

  it('500 internal_error: submit.server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockResolvedValueOnce(
      err({ kind: 'submit.server_error', message: 'db down' }),
    );
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
  });

  it('500 internal_error: thrown', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    proxySubmitMock.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await importRoute();
    const res = await POST(makeRequest(VALID_BODY));
    expect(res.status).toBe(500);
  });
});
