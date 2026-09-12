/**
 * F114 T069 — contract: `GET /api/portal/change-requests` (own history) +
 * `GET /api/portal/change-requests/[id]` (contracts/portal-change-requests-
 * api.md § history; US4 AS4; FR-029, FR-039).
 *
 * The REAL portal list / get use cases run over the in-memory fakes: the
 * primary sees their own + the company-level requests; the secondary sees
 * their own + the company-level ones but NEVER the primary's own-field
 * request; a `mixed` row shown to a non-submitter carries its company fields
 * only; `decidedBy` is the literal "organisation" and the staff note never
 * leaves the server; `submittedBy.isMe` per row; `state` / `cursor` / `limit`;
 * an out-of-scope id → 404 (never 403 — no existence leak); flag OFF → 404
 * before the member context; a staff session gets the member-context refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId, ProposedField } from '@/modules/members/domain/change-request/change-request';
import { makeAuditPortFake, makeClockFake, makeInMemoryChangeRequestRepo, type AuditPortFake, type InMemoryChangeRequestRepo } from '../../helpers/change-request-fakes';

const requireMemberContextMock = vi.fn();
const loggerError = vi.fn();
let flagOn = true;
let repo: InMemoryChangeRequestRepo;
let audit: AuditPortFake;

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
vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) => requireMemberContextMock(...args),
}));
vi.mock('@/lib/members-change-request-deps', () => ({
  asMembersUserId: (id: string) => id,
  buildChangeRequestDeps: vi.fn(() => ({
    tenant: { slug: 'test-swecham', __brand: true },
    changeRequestRepo: repo,
    audit,
    clock: makeClockFake(NOW),
  })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  membersMetrics: { changeRequests: { refused: vi.fn(), submitted: vi.fn(), decided: vi.fn(), decideDurationMs: vi.fn(), pendingCount: vi.fn(), oldestAgeSeconds: vi.fn() } },
}));

import { GET as listHistory } from '@/app/api/portal/change-requests/route';
import { GET as getOne } from '@/app/api/portal/change-requests/[id]/route';

const NOW = new Date('2026-09-12T08:00:00Z');
const DAY = 86_400_000;
const MEMBER = '11111111-1111-4111-8111-111111111111';
const OTHER_MEMBER = '11111111-1111-4111-8111-222222222222';
const PRIMARY_CONTACT = '22222222-2222-4222-8222-222222222222';
const SECONDARY_CONTACT = '22222222-2222-4222-8222-333333333333';
const PRIMARY = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const SECONDARY = 'a6c5b1a2-0000-4000-8000-00000000cccc';
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa';
const R = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const memberContext = (userId: string, contactId: string, isPrimary: boolean) => ({
  current: { user: { id: userId, email: 'x@nordic.example', role: 'member', status: 'active' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: { memberId: MEMBER, companyName: 'Nordic Co', status: 'active' },
  memberId: MEMBER,
  ownContact: { contactId, memberId: MEMBER, firstName: isPrimary ? 'Anna' : 'Bo', lastName: 'Svensson', isPrimary },
  ownContactId: contactId,
  sourceIp: '127.0.0.1',
  requestId: 'req-h1',
});

const phone = (outcome: ProposedField['outcome'] = null): ProposedField => ({ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome, appliedAt: outcome === 'approved' ? NOW : null });
const companyName = (outcome: ProposedField['outcome'] = null): ProposedField => ({ key: 'company_name', target: 'member', seen: 'Nordic Co', proposed: 'Nordic Company', affectsTaxDocuments: true, outcome, appliedAt: outcome === 'approved' ? NOW : null });

function request(id: string, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: id as ChangeRequestId,
    tenantId: 'test-swecham' as ChangeRequest['tenantId'],
    memberId: MEMBER as ChangeRequest['memberId'],
    submittedByUserId: PRIMARY as UserId,
    submittedByContactId: PRIMARY_CONTACT as ChangeRequest['submittedByContactId'],
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
    // the primary's own-contact request (pending)
    request(R(1), { submittedAt: new Date(NOW.getTime() - DAY) }),
    // the secondary's own-contact request (pending)
    request(R(2), { submittedByUserId: SECONDARY as UserId, submittedByContactId: SECONDARY_CONTACT as ChangeRequest['submittedByContactId'], submitterRoleAtSubmission: 'secondary', submittedAt: new Date(NOW.getTime() - 2 * DAY) }),
    // the primary's mixed request, decided with a reason + a staff note
    request(R(3), { scope: 'mixed', state: 'decided', outcome: 'partially_approved', submittedAt: new Date(NOW.getTime() - 3 * DAY), decidedAt: new Date(NOW.getTime() - 2 * DAY), decidedByUserId: REVIEWER as UserId, decisionReason: 'Use the registered phone', decisionNote: 'staff only', fields: [phone('rejected'), companyName('approved')] }),
    // the primary's company request, withdrawn
    request(R(4), { scope: 'company', state: 'withdrawn', withdrawnReason: 'member', submittedAt: new Date(NOW.getTime() - 5 * DAY), withdrawnAt: new Date(NOW.getTime() - 4 * DAY), fields: [companyName()] }),
    // another member's company request
    request(R(5), { memberId: OTHER_MEMBER as ChangeRequest['memberId'], scope: 'company', submittedByUserId: 'a6c5b1a2-0000-4000-8000-00000000dddd' as UserId, submittedByContactId: '22222222-2222-4222-8222-444444444444' as ChangeRequest['submittedByContactId'], fields: [companyName()] }),
  ];
}

function list(query = ''): Promise<Response> {
  return listHistory(new NextRequest(`http://localhost/api/portal/change-requests${query}`, { method: 'GET' }));
}
function one(id: string): Promise<Response> {
  return getOne(new NextRequest(`http://localhost/api/portal/change-requests/${id}`, { method: 'GET' }), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  flagOn = true;
  repo = makeInMemoryChangeRequestRepo(seed());
  audit = makeAuditPortFake();
  repo.display.users.set(PRIMARY, { displayName: 'Anna Svensson', deactivated: false });
  repo.display.users.set(SECONDARY, { displayName: 'Bo Svensson', deactivated: false });
  requireMemberContextMock.mockResolvedValue(memberContext(PRIMARY, PRIMARY_CONTACT, true));
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/portal/change-requests — own history (FR-029)', () => {
  it('404 while the flag is off — before the member context; a staff session gets the member-context refusal', async () => {
    flagOn = false;
    expect((await list()).status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
    flagOn = true;
    requireMemberContextMock.mockResolvedValueOnce({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    expect((await list()).status).toBe(403);
  });

  it('the primary sees own + company-level requests newest first as ChangeRequestViews: decidedBy "organisation", isMe, no staff note, no reviewer id', async () => {
    const res = await list();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([R(1), R(3), R(4)]);
    expect(body.nextCursor).toBeNull();
    expect(body.items[1]).toMatchObject({ id: R(3), state: 'decided', outcome: 'partially_approved', decidedBy: 'organisation', decisionReason: 'Use the registered phone', submittedBy: { contactId: PRIMARY_CONTACT, displayName: 'Anna Svensson', isMe: true } });
    expect(body.items[1].fields.map((f: { key: string; outcome: string }) => [f.key, f.outcome])).toEqual([['phone', 'rejected'], ['company_name', 'approved']]);
    const text = JSON.stringify(body);
    expect(text).not.toContain('staff only');
    expect(text).not.toContain(REVIEWER);
    expect(text).not.toContain('decidedByUserId');
  });

  it("the secondary sees their own + the company-level ones — never the primary's own-contact request — and a mixed row with its company fields only, isMe false", async () => {
    requireMemberContextMock.mockResolvedValue(memberContext(SECONDARY, SECONDARY_CONTACT, false));
    const body = await (await list()).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual([R(2), R(3), R(4)]);
    const mixed = body.items[1];
    expect(mixed.fields.map((f: { key: string }) => f.key)).toEqual(['company_name']);
    expect(mixed.submittedBy).toEqual({ contactId: PRIMARY_CONTACT, displayName: 'Anna Svensson', isMe: false });
    // FR-014: the reviewer's reason is the SUBMITTING person's — a colleague never sees it
    expect(mixed.decisionReason).toBeNull();
    expect(JSON.stringify(body)).not.toContain('Use the registered phone');
    // the primary's phone proposal (R1 own-contact + R3's contact row) never reaches the secondary
    expect(body.items.filter((i: { id: string }) => i.id !== R(2)).every((i: { fields: { target: string }[] }) => i.fields.every((f) => f.target === 'member'))).toBe(true);
  });

  it('state filter, limit + cursor paging; a malformed cursor / state / limit → 400', async () => {
    const decided = await (await list('?state=decided')).json();
    expect(decided.items.map((i: { id: string }) => i.id)).toEqual([R(3)]);
    const p1 = await (await list('?limit=2')).json();
    expect(p1.items.map((i: { id: string }) => i.id)).toEqual([R(1), R(3)]);
    const p2 = await (await list(`?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    expect(p2.items.map((i: { id: string }) => i.id)).toEqual([R(4)]);
    for (const bad of ['?cursor=garbage', '?state=archived', '?limit=0', '?limit=51']) {
      const res = await list(bad);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'invalid_query' });
    }
  });

  it('a repo fault → 500 named in the errorId taxonomy', async () => {
    repo.failNext('listVisibleToUser');
    expect((await list()).status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.portal.history.use_case_failed' }), expect.any(String));
  });
});

describe('GET /api/portal/change-requests/[id]', () => {
  it('in scope → 200 with the portal view; the mixed row for the secondary is stripped to company fields', async () => {
    const mine = await one(R(1));
    expect(mine.status).toBe(200);
    expect((await mine.json()).request).toMatchObject({ id: R(1), decidedBy: 'organisation', submittedBy: { isMe: true } });
    requireMemberContextMock.mockResolvedValue(memberContext(SECONDARY, SECONDARY_CONTACT, false));
    const mixed = await (await one(R(3))).json();
    expect(mixed.request.fields.map((f: { key: string }) => f.key)).toEqual(['company_name']);
    expect(mixed.request.submittedBy.isMe).toBe(false);
  });

  it("out of scope → 404, never 403: a colleague's own-contact request, another member's row, an unknown id, a malformed id", async () => {
    requireMemberContextMock.mockResolvedValue(memberContext(SECONDARY, SECONDARY_CONTACT, false));
    const colleague = await one(R(1));
    expect(colleague.status).toBe(404);
    expect(await colleague.json()).toEqual({ error: 'not_found' });
    requireMemberContextMock.mockResolvedValue(memberContext(PRIMARY, PRIMARY_CONTACT, true));
    expect((await one(R(5))).status).toBe(404);
    expect((await one(R(9))).status).toBe(404);
    expect((await one('nope')).status).toBe(404);
    // FR-035: the unknown / foreign id is audited as a probe (once per miss); the
    // colleague's own-contact row (visible in this tenant) is not a probe
    const probes = audit.events.filter((e) => e.type === 'member_cross_tenant_probe');
    expect(probes.map((e) => e.payload['attempted_change_request_id'])).toEqual([R(9)]);
    expect(probes[0]).toMatchObject({ actorUserId: PRIMARY, payload: { actor_tenant_id: 'test-swecham', action: 'history_item' } });
  });

  it('flag OFF → 404 before the member context; a repo fault → 500 named in the errorId taxonomy', async () => {
    flagOn = false;
    expect((await one(R(1))).status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
    flagOn = true;
    repo.failNext('findListRowById');
    expect((await one(R(1))).status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.portal.history_item.use_case_failed' }), expect.any(String));
  });
});
