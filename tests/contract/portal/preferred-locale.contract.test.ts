/**
 * R5 verify-fix Tests-H7 (2026-05-02) — contract test for portal
 * preferred-locale GET + PATCH.
 *
 * IDOR boundary: route uses `requireMemberContext` to derive memberId
 * from the SESSION (no `memberId` in URL or body). Future refactor
 * that accepts a body memberId would silently break this test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const setMemberPreferredLocaleMock = vi.fn();
const getMemberPreferredLocaleMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) =>
    requireMemberContextMock(...args),
}));

vi.mock('@/modules/members', () => ({
  setMemberPreferredLocale: (...args: unknown[]) =>
    setMemberPreferredLocaleMock(...args),
  getMemberPreferredLocale: (...args: unknown[]) =>
    getMemberPreferredLocaleMock(...args),
  f3DrizzleMemberRepo: {},
  f3DrizzleAuditAdapter: {},
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const memberCtx = {
  current: { user: { id: 'user-member-1', role: 'member' as const } },
  tenant: { slug: 'swecham' },
  memberId: '11111111-1111-4111-8111-111111111111',
  requestId: 'req-1',
};

function makePatchRequest(body: unknown) {
  return new NextRequest('http://localhost/api/portal/preferred-locale', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeGetRequest() {
  return new NextRequest('http://localhost/api/portal/preferred-locale');
}

async function importRoute() {
  return import('@/app/api/portal/preferred-locale/route');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/portal/preferred-locale', () => {
  it('200 returns current value derived from session memberId (IDOR boundary)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    getMemberPreferredLocaleMock.mockResolvedValueOnce(ok('th'));
    const { GET } = await importRoute();
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preferredLocale).toBe('th');
    // IDOR: use-case received the memberId from session, not from body/URL
    const useCaseArgs = getMemberPreferredLocaleMock.mock.calls[0]!;
    expect(useCaseArgs[1]).toBe(memberCtx.memberId);
  });

  it('500 surfaces repo error', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    getMemberPreferredLocaleMock.mockResolvedValueOnce(
      err({ kind: 'repo_error', cause: 'boom' }),
    );
    const { GET } = await importRoute();
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
  });

  it('rejects request when member context resolver returns response (e.g. 401)', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'unauth' }, { status: 401 }),
    });
    const { GET } = await importRoute();
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/portal/preferred-locale', () => {
  it('200 happy: writes session memberId + member_self_service actor', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    setMemberPreferredLocaleMock.mockResolvedValueOnce(
      ok({ kind: 'updated', previousValue: null, nextValue: 'sv' }),
    );
    const { PATCH } = await importRoute();
    const res = await PATCH(makePatchRequest({ preferredLocale: 'sv' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome.kind).toBe('updated');
    // IDOR: memberId comes from session, NOT from body
    const useCaseInput = setMemberPreferredLocaleMock.mock.calls[0]![1];
    expect(useCaseInput.memberId).toBe(memberCtx.memberId);
    expect(useCaseInput.actor.kind).toBe('member_self_service');
    expect(useCaseInput.actor.userId).toBe(memberCtx.current.user.id);
  });

  it('IDOR-proof: body memberId is IGNORED — session memberId always used', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    setMemberPreferredLocaleMock.mockResolvedValueOnce(
      ok({ kind: 'unchanged', currentValue: null }),
    );
    const { PATCH } = await importRoute();
    const attackerId = '99999999-9999-4999-8999-999999999999';
    await PATCH(
      makePatchRequest({ preferredLocale: null, memberId: attackerId }),
    );
    const useCaseInput = setMemberPreferredLocaleMock.mock.calls[0]![1];
    expect(useCaseInput.memberId).toBe(memberCtx.memberId); // session, NOT body
    expect(useCaseInput.memberId).not.toBe(attackerId);
  });

  it('400 invalid_body: malformed JSON', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { PATCH } = await importRoute();
    const req = new NextRequest('http://localhost/api/portal/preferred-locale', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await PATCH(req);
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: unknown locale rejected', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    const { PATCH } = await importRoute();
    const res = await PATCH(makePatchRequest({ preferredLocale: 'de' }));
    expect(res.status).toBe(400);
  });

  it('idempotent unchanged: 200 + outcome.kind unchanged (no audit)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberCtx);
    setMemberPreferredLocaleMock.mockResolvedValueOnce(
      ok({ kind: 'unchanged', currentValue: 'th' }),
    );
    const { PATCH } = await importRoute();
    const res = await PATCH(makePatchRequest({ preferredLocale: 'th' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome.kind).toBe('unchanged');
  });
});
