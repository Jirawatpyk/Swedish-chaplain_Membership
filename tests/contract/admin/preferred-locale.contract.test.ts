/**
 * R5 verify-fix Tests-H6 (2026-05-02) — contract test for admin
 * preferred-locale PATCH route.
 *
 * Tenant-isolation Review-Gate: route uses `resolveTenantFromRequest`
 * (F2 single-tenant returns env.tenant.slug constant; gated X-Tenant
 * header for tests). Use-case enforces tenant binding via runInTenant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const setMemberPreferredLocaleMock = vi.fn();
const tryMemberIdMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) =>
    requireAdminContextMock(...args),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham' }),
}));

vi.mock('@/modules/members', () => ({
  setMemberPreferredLocale: (...args: unknown[]) =>
    setMemberPreferredLocaleMock(...args),
  tryMemberId: (id: string) => tryMemberIdMock(id),
  f3DrizzleMemberRepo: {},
  f3DrizzleAuditAdapter: {},
}));

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const adminCtx = {
  current: { user: { id: 'user-admin-1', role: 'admin' as const } },
  requestId: 'req-1',
};

function makeRequest(body: unknown, pathId = VALID_ID) {
  const req = new NextRequest(
    `http://localhost/api/admin/members/${pathId}/preferred-locale`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { req, ctx: { params: Promise.resolve({ id: pathId }) } };
}

async function importRoute() {
  return import('@/app/api/admin/members/[id]/preferred-locale/route');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  tryMemberIdMock.mockImplementation((id: string) =>
    /^[0-9a-f]{8}-/.test(id)
      ? { ok: true, value: id }
      : { ok: false, error: { kind: 'invalid_uuid' } },
  );
});
afterEach(() => vi.clearAllMocks());

describe('PATCH /api/admin/members/[id]/preferred-locale', () => {
  it('200 happy: writes value + admin actor + memberId from URL', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    setMemberPreferredLocaleMock.mockResolvedValueOnce(
      ok({ kind: 'updated', previousValue: null, nextValue: 'sv' }),
    );
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'sv' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(200);
    const useCaseInput = setMemberPreferredLocaleMock.mock.calls[0]![1];
    expect(useCaseInput.memberId).toBe(VALID_ID);
    expect(useCaseInput.actor.kind).toBe('admin');
    expect(useCaseInput.actor.userId).toBe(adminCtx.current.user.id);
  });

  it('200 idempotent: same value → outcome.kind unchanged', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    setMemberPreferredLocaleMock.mockResolvedValueOnce(
      ok({ kind: 'unchanged', currentValue: 'th' }),
    );
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'th' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome.kind).toBe('unchanged');
  });

  it('404 member_not_found: invalid uuid in path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'th' }, 'not-a-uuid');
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(404);
  });

  it('404 member_not_found: use-case returns not_found (cross-tenant or absent)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    setMemberPreferredLocaleMock.mockResolvedValueOnce(
      ok({ kind: 'not_found' }),
    );
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'sv' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(404);
  });

  it('400 invalid_body: malformed JSON', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { PATCH } = await importRoute();
    const req = new NextRequest(
      `http://localhost/api/admin/members/${VALID_ID}/preferred-locale`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      },
    );
    const res = await PATCH(req, { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(400);
  });

  it('400 invalid_body: unknown locale rejected', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'de' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(400);
  });

  it('rejects request when admin context resolver returns response (e.g. 403 manager)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'th' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(403);
  });

  it('500 internal_error: use-case throws', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    setMemberPreferredLocaleMock.mockRejectedValueOnce(new Error('db down'));
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'th' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(500);
  });

  it('500 internal_error: use-case returns repo_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminCtx);
    setMemberPreferredLocaleMock.mockResolvedValueOnce(
      err({ kind: 'repo_error', cause: 'boom' }),
    );
    const { PATCH } = await importRoute();
    const { req, ctx } = makeRequest({ preferredLocale: 'sv' });
    const res = await PATCH(req, ctx);
    expect(res.status).toBe(500);
  });
});
