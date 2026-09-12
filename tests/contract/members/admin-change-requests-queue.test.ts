/**
 * F114 T067 — contract: `GET /api/admin/change-requests` — the queue
 * (contracts/admin-change-requests-api.md § queue; US4 AS2; FR-027, FR-033,
 * FR-039).
 *
 * The REAL `listChangeRequestQueue` runs over the in-memory fakes: default
 * `pending` oldest-first; filters `state`, `outcome`, `memberId`, `submitter`,
 * `from` / `to`; `overdue` true past 3 days + `waitingSeconds`; `pendingCount`
 * + `oldestPendingAgeSeconds`; keyset `cursor` / `limit ≤ 100` (a malformed
 * cursor or limit → 400 problem); the gate key is the literal `members.read`
 * (manager 200, a member session's refusal passes through as 403); flag OFF →
 * 404 before the gate; a repo fault → 500 named `M114.admin.queue.<arm>`; the
 * item shape carries the member, the submitter's role, `fieldCount`,
 * `affectsTaxDocuments` and the reviewer with the "deactivated" marker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId, ProposedField } from '@/modules/members/domain/change-request/change-request';
import { makeClockFake, makeInMemoryChangeRequestRepo, type InMemoryChangeRequestRepo } from '../../helpers/change-request-fakes';

const requireApiPermissionMock = vi.fn();
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
    clock: makeClockFake(NOW),
  })),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));

import { GET } from '@/app/api/admin/change-requests/route';

const NOW = new Date('2026-09-12T08:00:00Z');
const DAY = 86_400_000;
const MEMBER = '11111111-1111-4111-8111-111111111111';
const OTHER_MEMBER = '11111111-1111-4111-8111-222222222222';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const PRIMARY = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const SECONDARY = 'a6c5b1a2-0000-4000-8000-00000000cccc';
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const R = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const staffContext = (role: string) => ({
  current: { user: { id: REVIEWER, email: 'staff@swecham.example', role, status: 'active' }, session: { id: 's-1' } },
  sourceIp: '127.0.0.1',
  requestId: 'req-q1',
});

const phone = (outcome: ProposedField['outcome'] = null): ProposedField => ({ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome, appliedAt: outcome === 'approved' ? NOW : null });
const billing = (outcome: ProposedField['outcome'] = null): ProposedField => ({
  key: 'billing_address',
  target: 'member',
  seen: { line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null },
  proposed: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
  affectsTaxDocuments: true,
  outcome,
  appliedAt: outcome === 'approved' ? NOW : null,
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
    fields: [phone()],
    ...overrides,
  };
}

function seed(): ChangeRequest[] {
  return [
    request(R(1), { submittedAt: new Date(NOW.getTime() - 4 * DAY), staffNotifiedAt: new Date(NOW.getTime() - 4 * DAY), scope: 'mixed', fields: [phone(), billing()] }),
    request(R(2), { submittedByUserId: SECONDARY as UserId, submitterRoleAtSubmission: 'secondary', submittedAt: new Date(NOW.getTime() - DAY) }),
    request(R(3), { state: 'decided', outcome: 'rejected', submittedAt: new Date(NOW.getTime() - 3 * DAY), decidedAt: new Date(NOW.getTime() - 2 * DAY), decidedByUserId: REVIEWER as UserId, decisionReason: 'Use the registered phone', decisionNote: 'internal', fields: [phone('rejected')] }),
    request(R(4), { memberId: OTHER_MEMBER as ChangeRequest['memberId'], scope: 'company', submittedAt: new Date(NOW.getTime() - 2 * DAY), fields: [billing()] }),
  ];
}

function call(query = ''): Promise<Response> {
  return GET(new NextRequest(`http://localhost/api/admin/change-requests${query}`, { method: 'GET' }));
}

beforeEach(() => {
  flagOn = true;
  repo = makeInMemoryChangeRequestRepo(seed());
  repo.display.members.set(OTHER_MEMBER, { companyName: 'Other Co', memberNumber: 7, status: 'active', archived: false });
  repo.display.users.set(REVIEWER, { displayName: 'Reviewer Rae', deactivated: true });
  requireApiPermissionMock.mockResolvedValue(staffContext('admin'));
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/admin/change-requests', () => {
  it('404 while the platform flag is off — before the gate (FR-039)', async () => {
    flagOn = false;
    expect((await call()).status).toBe(404);
    expect(requireApiPermissionMock).not.toHaveBeenCalled();
  });

  it("hands the gate the literal key 'members.read'; a manager reads the queue; a refused session (member) is a pass-through 403", async () => {
    requireApiPermissionMock.mockResolvedValue(staffContext('manager'));
    expect((await call()).status).toBe(200);
    expect(requireApiPermissionMock).toHaveBeenCalledWith(expect.anything(), 'members.read');
    requireApiPermissionMock.mockResolvedValue({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
  });

  it('default: pending oldest-first with waiting time, the overdue flag past 3 days, pendingCount and the oldest pending age; the item shape', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([R(1), R(4), R(2)]);
    expect(body.pendingCount).toBe(3);
    expect(body.oldestPendingAgeSeconds).toBe(4 * 86_400);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toEqual({
      id: R(1),
      member: { id: MEMBER, companyName: 'Fake Co', memberNumber: 1, status: 'active', archived: false },
      submitter: { displayName: 'Submitter', roleAtSubmission: 'primary' },
      scope: 'mixed',
      state: 'pending',
      outcome: null,
      withdrawnReason: null,
      fieldCount: 2,
      affectsTaxDocuments: true,
      submittedAt: new Date(NOW.getTime() - 4 * DAY).toISOString(),
      waitingSeconds: 4 * 86_400,
      overdue: true,
      decidedAt: null,
      decidedBy: null,
    });
    expect(body.items[2]).toMatchObject({ id: R(2), submitter: { roleAtSubmission: 'secondary' }, fieldCount: 1, affectsTaxDocuments: false, waitingSeconds: 86_400, overdue: false });
    // a list row never carries field VALUES or the staff note
    const text = JSON.stringify(body);
    expect(text).not.toContain('+668');
    expect(text).not.toContain('Box 9');
    expect(text).not.toContain('internal');
  });

  it('filters: state=decided (+ outcome) newest first with the reviewer + deactivated marker; memberId; submitter; from/to', async () => {
    const decided = await (await call('?state=decided&outcome=rejected')).json();
    expect(decided.items.map((i: { id: string }) => i.id)).toEqual([R(3)]);
    expect(decided.items[0]).toMatchObject({ state: 'decided', outcome: 'rejected', decidedAt: new Date(NOW.getTime() - 2 * DAY).toISOString(), decidedBy: { displayName: 'Reviewer Rae', deactivated: true }, waitingSeconds: 86_400, overdue: false });
    expect(decided.items[0]).not.toHaveProperty('decisionReason');
    const byMember = await (await call(`?memberId=${OTHER_MEMBER}`)).json();
    expect(byMember.items.map((i: { id: string }) => i.id)).toEqual([R(4)]);
    expect(byMember.items[0].member).toEqual({ id: OTHER_MEMBER, companyName: 'Other Co', memberNumber: 7, status: 'active', archived: false });
    const bySubmitter = await (await call(`?submitter=${SECONDARY}&state=pending`)).json();
    expect(bySubmitter.items.map((i: { id: string }) => i.id)).toEqual([R(2)]);
    const from = new Date(NOW.getTime() - 2.5 * DAY).toISOString();
    const to = new Date(NOW.getTime() - 1.5 * DAY).toISOString();
    const range = await (await call(`?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json();
    expect(range.items.map((i: { id: string }) => i.id)).toEqual([R(4)]);
  });

  it('keyset paging: limit + cursor walk the queue without gaps; limit is bounded to 1..100 (400 outside); a malformed cursor → 400', async () => {
    const p1 = await (await call('?limit=2')).json();
    expect(p1.items.map((i: { id: string }) => i.id)).toEqual([R(1), R(4)]);
    expect(typeof p1.nextCursor).toBe('string');
    const p2 = await (await call(`?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    expect(p2.items.map((i: { id: string }) => i.id)).toEqual([R(2)]);
    expect(p2.nextCursor).toBeNull();
    for (const bad of ['?limit=0', '?limit=101', '?limit=abc', '?cursor=garbage', '?state=archived', '?memberId=nope', '?from=yesterday']) {
      const res = await call(bad);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ status: 400, type: expect.stringMatching(/invalid_query$/) });
    }
  });

  it('a repo fault → 500 problem named in the errorId taxonomy', async () => {
    repo.failNext('listQueue');
    const res = await call();
    expect(res.status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.admin.queue.use_case_failed' }), expect.any(String));
  });
});
