/**
 * Contract test — F9 US6 data-export REQUEST routes (W3 staff-review remediation).
 *
 * Verifies the HTTP auth/role/flag gating each new route enforces around the
 * (separately-tested) `requestDataExport` use-case:
 *   - POST /api/portal/account/data-export  (member self-service)
 *   - POST /api/admin/members/[id]/data-export  (admin on-behalf, FR-031)
 *
 * Error mappings: feature-off → 503, no session → 401, wrong role → 403,
 * no member profile → 404, invalid id → 404, ok → 202.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

let f9Flag = true;
let sessionResult: { user: { id: string; role: 'admin' | 'manager' | 'member' } } | null = null;
let memberLookup: { ok: boolean; value?: { memberId: string }; error?: { code: string } } = {
  ok: true,
  value: { memberId: 'mem-self' },
};
let adminCtx: unknown;
let memberIdValid = true;
const requestDataExportMock = vi.fn();

vi.mock('@/lib/env', () => ({
  env: { features: { get f9Dashboard() { return f9Flag; } } },
}));
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => Promise.resolve(sessionResult),
}));
vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: () => Promise.resolve(adminCtx),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham' }),
}));
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve('en') }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: { findByLinkedUserId: () => Promise.resolve(memberLookup) },
  }),
}));
vi.mock('@/modules/members', () => ({
  tryMemberId: (id: string) =>
    memberIdValid ? { ok: true, value: id } : { ok: false, error: { code: 'invalid' } },
}));
vi.mock('@/modules/insights', () => ({
  requestDataExport: (...a: unknown[]) => requestDataExportMock(...a),
  makeRequestDataExportDeps: () => ({}),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/log-id', () => ({ errKind: () => 'MockError' }));

function memberReq() {
  return new NextRequest('http://localhost/api/portal/account/data-export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  f9Flag = true;
  sessionResult = { user: { id: 'u-member', role: 'member' } };
  memberLookup = { ok: true, value: { memberId: 'mem-self' } };
  memberIdValid = true;
  adminCtx = { current: { user: { id: 'u-admin', role: 'admin' } }, requestId: 'rq-1' };
  requestDataExportMock.mockResolvedValue(ok({ jobId: 'job-1', status: 'requested', created: true }));
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/portal/account/data-export (member self-service)', () => {
  const route = () => import('@/app/api/portal/account/data-export/route');

  it('feature off → 503', async () => {
    f9Flag = false;
    const res = await (await route()).POST(memberReq());
    expect(res.status).toBe(503);
  });

  it('no session → 401', async () => {
    sessionResult = null;
    const res = await (await route()).POST(memberReq());
    expect(res.status).toBe(401);
  });

  it('non-member (admin) → 403', async () => {
    sessionResult = { user: { id: 'u-admin', role: 'admin' } };
    const res = await (await route()).POST(memberReq());
    expect(res.status).toBe(403);
  });

  it('no member profile → 404', async () => {
    memberLookup = { ok: false, error: { code: 'repo.not_found' } };
    const res = await (await route()).POST(memberReq());
    expect(res.status).toBe(404);
  });

  it('member lookup DB fault → 500, NOT a masked 404 (review C2)', async () => {
    // A DB/RLS fault (repo.unexpected) must surface as 500 — never be conflated
    // with "no profile" (404), which would silently drop a GDPR portability req.
    memberLookup = { ok: false, error: { code: 'repo.unexpected' } };
    const res = await (await route()).POST(memberReq());
    expect(res.status).toBe(500);
    expect(requestDataExportMock).not.toHaveBeenCalled();
  });

  it('use-case forbidden → 403', async () => {
    requestDataExportMock.mockResolvedValue(err('forbidden'));
    const res = await (await route()).POST(memberReq());
    expect(res.status).toBe(403);
  });

  it('ok → 202 with jobId', async () => {
    const res = await (await route()).POST(memberReq());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.jobId).toBe('job-1');
  });
});

describe('POST /api/admin/members/[id]/data-export (admin on-behalf)', () => {
  const route = () => import('@/app/api/admin/members/[id]/data-export/route');
  const ctx = { params: Promise.resolve({ id: '11111111-1111-1111-1111-111111111111' }) };

  it('feature off → 503', async () => {
    f9Flag = false;
    const res = await (await route()).POST(memberReq(), ctx);
    expect(res.status).toBe(503);
  });

  it('requireAdminContext rejection short-circuits (manager/no session)', async () => {
    adminCtx = { response: new Response(null, { status: 403 }) };
    const res = await (await route()).POST(memberReq(), ctx);
    expect(res.status).toBe(403);
  });

  it('invalid member id → 404', async () => {
    memberIdValid = false;
    const res = await (await route()).POST(memberReq(), ctx);
    expect(res.status).toBe(404);
  });

  it('ok → 202, attributed to the admin', async () => {
    const res = await (await route()).POST(memberReq(), ctx);
    expect(res.status).toBe(202);
    // The use-case was called with the admin actor (on-behalf).
    const meta = requestDataExportMock.mock.calls[0]![1] as { actorRole: string; actorMemberId: null };
    expect(meta.actorRole).toBe('admin');
    expect(meta.actorMemberId).toBeNull();
  });
});
