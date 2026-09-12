/**
 * F114 T068 — contract: `GET /api/admin/members/[id]/change-requests`
 * — the per-member history (contracts/admin-change-requests-api.md
 * § per-member history; US4 AS1; FR-026, FR-039).
 *
 * The REAL `listMemberChangeRequests` runs over the in-memory fakes: every
 * state, newest first, the queue item shape; the member must exist in the
 * caller's tenant (`memberRepo.findById` — another tenant's member is
 * invisible under RLS, so it is a 404, never a 403; a malformed id → 404);
 * keyset `cursor` / `limit`; the gate key is the literal `members.read`;
 * flag OFF → 404 before the gate; a repo fault → 500 named
 * `M114.admin.member_history.<arm>`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { err, ok } from '@/lib/result';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { makeClockFake, makeInMemoryChangeRequestRepo, type InMemoryChangeRequestRepo } from '../../helpers/change-request-fakes';

const requireApiPermissionMock = vi.fn();
const memberFindByIdMock = vi.fn();
const loggerError = vi.fn();
let flagOn = true;
let repo: InMemoryChangeRequestRepo;

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
vi.mock('@/lib/db', () => ({ db: {}, runInTenant: vi.fn() }));
vi.mock('@/lib/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rbac')>('@/lib/rbac');
  return { ...actual, requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args) };
});
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    changeRequestRepo: repo,
    memberRepo: { findById: (...a: unknown[]) => memberFindByIdMock(...a) },
    clock: makeClockFake(NOW),
  })),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));

import { GET } from '@/app/api/admin/members/[id]/change-requests/route';

const NOW = new Date('2026-09-12T08:00:00Z');
const DAY = 86_400_000;
const MEMBER = '11111111-1111-4111-8111-111111111111';
const OTHER_MEMBER = '11111111-1111-4111-8111-222222222222';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const PRIMARY = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const R = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const staffContext = (role: string) => ({
  current: { user: { id: REVIEWER, email: 'staff@swecham.example', role, status: 'active' }, session: { id: 's-1' } },
  sourceIp: '127.0.0.1',
  requestId: 'req-mh1',
});

function request(id: string, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: id as ChangeRequestId,
    tenantId: 'test-swecham' as ChangeRequest['tenantId'],
    memberId: MEMBER as ChangeRequest['memberId'],
    submittedByUserId: PRIMARY as UserId,
    submittedByContactId: CONTACT as ChangeRequest['submittedByContactId'],
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'pending',
    outcome: null,
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: new Date(NOW.getTime() - DAY),
    staffNotifiedAt: new Date(NOW.getTime() - DAY),
    decidedAt: null,
    decidedByUserId: null,
    decisionReason: null,
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null }],
    ...overrides,
  };
}

function seed(): ChangeRequest[] {
  return [
    request(R(1), { submittedAt: new Date(NOW.getTime() - 4 * DAY) }),
    request(R(2), { state: 'decided', outcome: 'approved', submittedAt: new Date(NOW.getTime() - 3 * DAY), decidedAt: new Date(NOW.getTime() - 2 * DAY), decidedByUserId: REVIEWER as UserId, fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'approved', appliedAt: NOW }] }),
    request(R(3), { state: 'withdrawn', withdrawnReason: 'replaced', replacedByRequestId: R(1) as ChangeRequestId, submittedAt: new Date(NOW.getTime() - 5 * DAY), withdrawnAt: new Date(NOW.getTime() - 4 * DAY) }),
    request(R(4), { memberId: OTHER_MEMBER as ChangeRequest['memberId'], scope: 'company', submittedAt: new Date(NOW.getTime() - 2 * DAY) }),
  ];
}

function call(memberId = MEMBER, query = ''): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/admin/members/${memberId}/change-requests${query}`, { method: 'GET' }), { params: Promise.resolve({ id: memberId }) });
}

beforeEach(() => {
  flagOn = true;
  repo = makeInMemoryChangeRequestRepo(seed());
  memberFindByIdMock.mockImplementation(async (_ctx: unknown, id: string) => (id === MEMBER ? ok({ memberId: MEMBER, companyName: 'Nordic Co', status: 'active' }) : err({ code: 'repo.not_found' })));
  requireApiPermissionMock.mockResolvedValue(staffContext('admin'));
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/members/[id]/change-requests', () => {
  it('404 while the platform flag is off — before the gate', async () => {
    flagOn = false;
    expect((await call()).status).toBe(404);
    expect(requireApiPermissionMock).not.toHaveBeenCalled();
  });

  it("hands the gate the literal key 'members.read' and passes its 403 through", async () => {
    requireApiPermissionMock.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'members.read');
  });

  it('every state of the member, newest first, in the queue item shape; other members\' rows absent', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    // newest first: R2 (3 d, decided), R1 (4 d, pending), R3 (5 d, withdrawn)
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([R(2), R(1), R(3)]);
    expect(body.items.map((i: { state: string }) => i.state)).toEqual(['decided', 'pending', 'withdrawn']);
    expect(body.items[0]).toMatchObject({ outcome: 'approved', decidedBy: { displayName: 'Reviewer', deactivated: false }, waitingSeconds: 86_400, overdue: false });
    expect(body.items[2]).toMatchObject({ withdrawnReason: 'replaced', overdue: false });
    expect(body.items[1]).toMatchObject({ overdue: true, waitingSeconds: 4 * 86_400 });
    expect(body.nextCursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain('+668');
  });

  it('keyset paging with limit + cursor', async () => {
    const p1 = await (await call(MEMBER, '?limit=2')).json();
    expect(p1.items.map((i: { id: string }) => i.id)).toEqual([R(2), R(1)]);
    const p2 = await (await call(MEMBER, `?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    expect(p2.items.map((i: { id: string }) => i.id)).toEqual([R(3)]);
    expect((await call(MEMBER, '?cursor=garbage')).status).toBe(400);
  });

  it("another tenant's member (invisible under RLS) → 404 problem; a malformed id → 404; the list is never read", async () => {
    const res = await call(OTHER_MEMBER);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: 404, type: expect.stringMatching(/not_found$/) });
    expect((await call('nope')).status).toBe(404);
  });

  it('a repo fault → 500 problem named in the errorId taxonomy', async () => {
    repo.failNext('listByMember');
    expect((await call()).status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.admin.member_history.use_case_failed' }), expect.any(String));
  });
});
