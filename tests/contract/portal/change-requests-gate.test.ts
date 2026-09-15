/**
 * F114 T030 — contract: `GET /api/portal/change-requests/gate`
 * (contracts/portal-change-requests-api.md § 1).
 *
 * `mode` = the resolver's answer; `canProposeCompanyFields` = the caller's
 * contact `is_primary`; `pending` = the caller's OWN pending request only
 * (never another contact's) as a compact `{ id, submittedAt, fieldKeys }`.
 * 404 while the flag is off; a staff session gets the member-context refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireMemberContextMock = vi.fn();
const resolveGateMock = vi.fn(async () => 'approval');
const findPendingMock = vi.fn();
const loggerError = vi.fn();
let flagOn = true;

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    env: {
      ...actual.env,
      features: new Proxy(actual.env.features, {
        get: (target, prop) => (prop === 'memberChangeApproval' ? flagOn : Reflect.get(target, prop)),
      }),
    },
  };
});
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({ __tx: true })),
}));
vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    memberChangeGate: { resolve: (...args: unknown[]) => resolveGateMock(...(args as [])) },
    changeRequestRepo: { findPendingBySubmitter: (...args: unknown[]) => findPendingMock(...args) },
  })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));

const NOW = new Date('2026-09-11T08:00:00Z');
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function ctx(isPrimary: boolean) {
  return {
    current: { user: { id: USER, email: 'a@b.co', role: 'member', status: 'active' }, session: { id: 's-1' } },
    tenant: { slug: 'test-swecham', __brand: true },
    member: { memberId: 'm-1' },
    memberId: 'm-1',
    ownContact: { contactId: 'c-1', memberId: 'm-1', isPrimary },
    ownContactId: 'c-1',
    sourceIp: '127.0.0.1',
    requestId: 'req-1',
  };
}

const pending = {
  id: REQUEST_ID,
  submittedAt: NOW,
  fields: [{ key: 'phone' }, { key: 'billing_address' }],
};

async function loadRoute() {
  return import('@/app/api/portal/change-requests/gate/route');
}
const req = () => new NextRequest('http://localhost/api/portal/change-requests/gate', { method: 'GET' });

describe('contract: GET /api/portal/change-requests/gate (F114 T030)', () => {
  beforeEach(() => {
    flagOn = true;
    resolveGateMock.mockResolvedValue('approval');
    findPendingMock.mockResolvedValue(ok(null));
  });
  afterEach(() => vi.clearAllMocks());

  it('404 while the flag is off', async () => {
    flagOn = false;
    const { GET } = await loadRoute();
    expect((await GET(req())).status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
  });

  it('a staff session gets the member-context refusal', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    const { GET } = await loadRoute();
    expect((await GET(req())).status).toBe(403);
  });

  it('primary with no pending request → approval / canProposeCompanyFields true / pending null', async () => {
    requireMemberContextMock.mockResolvedValueOnce(ctx(true));
    const { GET } = await loadRoute();
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: 'approval', canProposeCompanyFields: true, pending: null });
    expect(findPendingMock).toHaveBeenCalledWith(expect.objectContaining({ slug: 'test-swecham' }), USER);
  });

  it('secondary with a pending request → canProposeCompanyFields false + the compact pending shape', async () => {
    requireMemberContextMock.mockResolvedValueOnce(ctx(false));
    findPendingMock.mockResolvedValueOnce(ok(pending));
    const { GET } = await loadRoute();
    const res = await GET(req());
    expect(await res.json()).toEqual({
      mode: 'approval',
      canProposeCompanyFields: false,
      pending: { id: REQUEST_ID, submittedAt: NOW.toISOString(), fieldKeys: ['phone', 'billing_address'] },
    });
  });

  it('gate immediate → mode immediate, and the pending read is SKIPPED (nothing to show)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(ctx(true));
    resolveGateMock.mockResolvedValueOnce('immediate');
    const { GET } = await loadRoute();
    const res = await GET(req());
    expect(await res.json()).toEqual({ mode: 'immediate', canProposeCompanyFields: true, pending: null });
    expect(findPendingMock).not.toHaveBeenCalled();
  });

  it('a repo failure on the pending read → 500 with its errorId', async () => {
    requireMemberContextMock.mockResolvedValueOnce(ctx(true));
    findPendingMock.mockResolvedValueOnce(err({ code: 'repo.unexpected' }));
    const { GET } = await loadRoute();
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.portal.gate.pending_read_failed' }), expect.any(String));
  });
});
