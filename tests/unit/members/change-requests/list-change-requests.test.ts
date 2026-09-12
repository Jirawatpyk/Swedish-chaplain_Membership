/**
 * F114 T071 — `list-change-requests` (US4; FR-026, FR-027, FR-029;
 * contracts/admin-change-requests-api.md § queue, portal-change-requests-api.md
 * § history).
 *
 * Pinned over the in-memory repo:
 *   - the opaque keyset cursor round-trips and a malformed one is
 *     `invalid_cursor` (never a 500, never page 1 silently);
 *   - `waitingSeconds` / `overdue`: a pending row waits from submission to
 *     now and is overdue past 3 days (FR-027); a decided / withdrawn row
 *     waited until its decision / withdrawal and is never overdue;
 *   - the queue is pending oldest-first by default, history newest-first,
 *     with `pendingCount` + `oldestPendingAgeSeconds` (FR-033 / SC-008);
 *   - the per-member list carries every state newest-first (FR-026);
 *   - FR-029 (portal): a person sees their own requests + the member's
 *     `company` / `mixed` ones, never a colleague's `own_contact` request;
 *     a `mixed` row shown to a NON-submitter carries its company fields ONLY
 *     (the contact-target rows are stripped — whole-branch round 3, F-10);
 *   - `getPortalChangeRequest`: out of scope → `not_found` (no existence
 *     leak), another member's row → `not_found`, a repo fault → `server_error`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asContactId } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId, ProposedField } from '@/modules/members/domain/change-request/change-request';
import {
  decodeChangeRequestCursor,
  encodeChangeRequestCursor,
  getPortalChangeRequest,
  isOverdue,
  listChangeRequestQueue,
  listMemberChangeRequests,
  listPortalChangeRequests,
  projectChangeRequestForViewer,
  waitingSecondsOf,
} from '@/modules/members/application/use-cases/change-requests/list-change-requests';
import { makeClockFake, makeInMemoryChangeRequestRepo } from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const OTHER_MEMBER = asMemberId('11111111-1111-4111-8111-222222222222');
const PRIMARY_CONTACT = asContactId('22222222-2222-4222-8222-222222222222');
const SECONDARY_CONTACT = asContactId('22222222-2222-4222-8222-333333333333');
const PRIMARY = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const SECONDARY = 'a6c5b1a2-0000-4000-8000-00000000cccc' as UserId;
const REVIEWER = 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId;
const NOW = new Date('2026-09-12T08:00:00Z');
const DAY = 24 * 3600_000;

const phone = (outcome: ProposedField['outcome'] = null): ProposedField => ({ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome, appliedAt: outcome === 'approved' ? NOW : null });
const companyName = (outcome: ProposedField['outcome'] = null): ProposedField => ({ key: 'company_name', target: 'member', seen: 'Nordic Co', proposed: 'Nordic Company', affectsTaxDocuments: true, outcome, appliedAt: outcome === 'approved' ? NOW : null });

function request(id: string, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: id as ChangeRequestId,
    tenantId: 'test-tenant' as ChangeRequest['tenantId'],
    memberId: MEMBER,
    submittedByUserId: PRIMARY,
    submittedByContactId: PRIMARY_CONTACT,
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

const R = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function seed() {
  return [
    // pending, 4 days old → overdue
    request(R(1), { submittedAt: new Date(NOW.getTime() - 4 * DAY), staffNotifiedAt: new Date(NOW.getTime() - 4 * DAY) }),
    // pending, 1 day old, a secondary's own-contact request
    request(R(2), { submittedByUserId: SECONDARY, submittedByContactId: SECONDARY_CONTACT, submitterRoleAtSubmission: 'secondary', submittedAt: new Date(NOW.getTime() - DAY) }),
    // decided (partially approved, mixed) — submitted 3 days ago, decided 2 days ago
    request(R(3), {
      scope: 'mixed',
      state: 'decided',
      outcome: 'partially_approved',
      submittedAt: new Date(NOW.getTime() - 3 * DAY),
      decidedAt: new Date(NOW.getTime() - 2 * DAY),
      decidedByUserId: REVIEWER,
      decisionReason: 'Use the registered phone',
      fields: [phone('rejected'), companyName('approved')],
    }),
    // withdrawn/member, company scope, submitted 5 days ago withdrawn 4.5 days ago
    request(R(4), { scope: 'company', state: 'withdrawn', withdrawnReason: 'member', submittedAt: new Date(NOW.getTime() - 5 * DAY), withdrawnAt: new Date(NOW.getTime() - 4.5 * DAY), fields: [companyName()] }),
    // another member's pending request (company)
    request(R(5), { memberId: OTHER_MEMBER, scope: 'company', submittedByUserId: 'a6c5b1a2-0000-4000-8000-00000000dddd' as UserId, submittedByContactId: asContactId('22222222-2222-4222-8222-444444444444'), submittedAt: new Date(NOW.getTime() - 2 * DAY), fields: [companyName()] }),
  ];
}

function makeDeps(rows = seed()) {
  const repo = makeInMemoryChangeRequestRepo(rows);
  repo.display.users.set(REVIEWER, { displayName: 'Reviewer Rae', deactivated: true });
  return { deps: { tenant, changeRequestRepo: repo, clock: makeClockFake(NOW) }, repo };
}

beforeEach(() => vi.clearAllMocks());

describe('cursor', () => {
  it('round-trips (submittedAt, id) through an opaque string', () => {
    const c = { submittedAt: NOW, id: R(1) as ChangeRequestId };
    const s = encodeChangeRequestCursor(c);
    expect(s).not.toContain('|');
    expect(decodeChangeRequestCursor(s)).toEqual(c);
  });

  it('a malformed cursor decodes to null', () => {
    expect(decodeChangeRequestCursor('nope')).toBeNull();
    expect(decodeChangeRequestCursor(Buffer.from('not-a-date|not-a-uuid').toString('base64url'))).toBeNull();
    expect(decodeChangeRequestCursor('')).toBeNull();
  });
});

describe('waiting time + overdue (FR-027)', () => {
  it('a pending row waits from submission to now; overdue past 3 days', () => {
    const fresh = request(R(1), { submittedAt: new Date(NOW.getTime() - 2 * DAY) });
    expect(waitingSecondsOf(fresh, NOW)).toBe(2 * 86_400);
    expect(isOverdue(fresh, NOW)).toBe(false);
    const old = request(R(1), { submittedAt: new Date(NOW.getTime() - 3 * DAY - 1000) });
    expect(isOverdue(old, NOW)).toBe(true);
    expect(isOverdue(request(R(1), { submittedAt: new Date(NOW.getTime() - 3 * DAY) }), NOW)).toBe(false);
  });

  it('a decided row waited until its decision and is never overdue; a withdrawn row until its withdrawal', () => {
    const decided = seed()[2]!;
    expect(waitingSecondsOf(decided, NOW)).toBe(86_400);
    expect(isOverdue(decided, NOW)).toBe(false);
    const withdrawn = seed()[3]!;
    expect(waitingSecondsOf(withdrawn, NOW)).toBe(43_200);
    expect(isOverdue(withdrawn, NOW)).toBe(false);
  });
});

describe('listChangeRequestQueue (FR-027, FR-033)', () => {
  it('default: pending, oldest first, with waiting time / overdue, pendingCount and the oldest pending age', async () => {
    const { deps } = makeDeps();
    const r = await listChangeRequestQueue(deps, { filter: {}, cursor: null, limit: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.map((i) => i.row.request.id)).toEqual([R(1), R(5), R(2)]);
    expect(r.value.items[0]).toMatchObject({ waitingSeconds: 4 * 86_400, overdue: true });
    expect(r.value.items[2]).toMatchObject({ waitingSeconds: 86_400, overdue: false });
    expect(r.value.pendingCount).toBe(3);
    expect(r.value.oldestPendingAgeSeconds).toBe(4 * 86_400);
    expect(r.value.nextCursor).toBeNull();
  });

  it('filters: state / outcome / memberId / submitter / date range; decided rows newest first with the reviewer (deactivated marker)', async () => {
    const { deps } = makeDeps();
    const decided = await listChangeRequestQueue(deps, { filter: { state: 'decided', outcome: 'partially_approved' }, cursor: null, limit: 50 });
    expect(decided.ok && decided.value.items.map((i) => i.row.request.id)).toEqual([R(3)]);
    expect(decided.ok && decided.value.items[0]?.row.decidedBy).toEqual({ displayName: 'Reviewer Rae', deactivated: true });
    const byMember = await listChangeRequestQueue(deps, { filter: { memberId: OTHER_MEMBER }, cursor: null, limit: 50 });
    expect(byMember.ok && byMember.value.items.map((i) => i.row.request.id)).toEqual([R(5)]);
    const bySubmitter = await listChangeRequestQueue(deps, { filter: { submitterUserId: SECONDARY }, cursor: null, limit: 50 });
    expect(bySubmitter.ok && bySubmitter.value.items.map((i) => i.row.request.id)).toEqual([R(2)]);
    const range = await listChangeRequestQueue(deps, { filter: { from: new Date(NOW.getTime() - 2.5 * DAY), to: new Date(NOW.getTime() - 1.5 * DAY) }, cursor: null, limit: 50 });
    expect(range.ok && range.value.items.map((i) => i.row.request.id)).toEqual([R(5)]);
    // pendingCount is the TENANT's pending count, not the filtered page's
    expect(decided.ok && decided.value.pendingCount).toBe(3);
  });

  it('keyset paging: walks the queue without gaps or duplicates; the limit is clamped to 1..100', async () => {
    const { deps } = makeDeps();
    const p1 = await listChangeRequestQueue(deps, { filter: {}, cursor: null, limit: 2 });
    if (!p1.ok) throw new Error('p1');
    expect(p1.value.items.map((i) => i.row.request.id)).toEqual([R(1), R(5)]);
    expect(p1.value.nextCursor).not.toBeNull();
    const p2 = await listChangeRequestQueue(deps, { filter: {}, cursor: p1.value.nextCursor, limit: 2 });
    if (!p2.ok) throw new Error('p2');
    expect(p2.value.items.map((i) => i.row.request.id)).toEqual([R(2)]);
    expect(p2.value.nextCursor).toBeNull();
    const clamped = await listChangeRequestQueue(deps, { filter: {}, cursor: null, limit: 500 });
    expect(clamped.ok).toBe(true);
  });

  it('a malformed cursor → invalid_cursor; a repo fault → server_error', async () => {
    const { deps, repo } = makeDeps();
    expect(await listChangeRequestQueue(deps, { filter: {}, cursor: 'garbage', limit: 10 })).toEqual({ ok: false, error: { type: 'invalid_cursor' } });
    repo.failNext('listQueue');
    const r = await listChangeRequestQueue(deps, { filter: {}, cursor: null, limit: 10 });
    expect(!r.ok && r.error.type).toBe('server_error');
    repo.failNext('pendingStats');
    const s = await listChangeRequestQueue(deps, { filter: {}, cursor: null, limit: 10 });
    expect(!s.ok && s.error.type).toBe('server_error');
  });
});

describe('listMemberChangeRequests (FR-026)', () => {
  it('every state of ONE member, newest first, with per-field outcomes', async () => {
    const { deps } = makeDeps();
    const r = await listMemberChangeRequests(deps, { memberId: MEMBER, cursor: null, limit: 50 });
    if (!r.ok) throw new Error('list');
    expect(r.value.items.map((i) => i.row.request.id)).toEqual([R(2), R(1), R(3), R(4)]);
    expect(r.value.items.map((i) => i.row.request.state)).toEqual(['pending', 'pending', 'decided', 'withdrawn']);
    expect(r.value.items[2]?.row.request.fields.map((f) => f.outcome)).toEqual(['rejected', 'approved']);
  });
});

describe('FR-029 — the portal projection', () => {
  it('the primary sees their own + the company-level requests; the secondary sees theirs + company-level, never the primary\'s own-contact request', async () => {
    const { deps } = makeDeps();
    const primary = await listPortalChangeRequests(deps, { userId: PRIMARY, memberId: MEMBER, cursor: null, limit: 20 });
    expect(primary.ok && primary.value.items.map((r) => r.request.id)).toEqual([R(1), R(3), R(4)]);
    const secondary = await listPortalChangeRequests(deps, { userId: SECONDARY, memberId: MEMBER, cursor: null, limit: 20 });
    expect(secondary.ok && secondary.value.items.map((r) => r.request.id)).toEqual([R(2), R(3), R(4)]);
    // the primary's own-contact request R(1) is absent for the secondary; R(2) absent for the primary
  });

  it('a mixed row shown to a NON-submitter carries its company fields only; the submitter sees all of it', async () => {
    const { deps } = makeDeps();
    const secondary = await listPortalChangeRequests(deps, { userId: SECONDARY, memberId: MEMBER, cursor: null, limit: 20 });
    const mixed = secondary.ok ? secondary.value.items.find((r) => r.request.id === R(3)) : undefined;
    expect(mixed?.request.fields.map((f) => f.key)).toEqual(['company_name']);
    const primary = await listPortalChangeRequests(deps, { userId: PRIMARY, memberId: MEMBER, cursor: null, limit: 20 });
    const mine = primary.ok ? primary.value.items.find((r) => r.request.id === R(3)) : undefined;
    expect(mine?.request.fields.map((f) => f.key)).toEqual(['phone', 'company_name']);
    // the pure projection is the same rule
    const row = { request: seed()[2]!, member: { companyName: 'Nordic Co', memberNumber: 1, status: 'active' as const, archived: false }, submitter: { displayName: 'Anna' }, decidedBy: null };
    expect(projectChangeRequestForViewer(row, SECONDARY).request.fields.map((f) => f.key)).toEqual(['company_name']);
    expect(projectChangeRequestForViewer(row, PRIMARY)).toBe(row);
  });

  it('a state filter narrows the portal list', async () => {
    const { deps } = makeDeps();
    const r = await listPortalChangeRequests(deps, { userId: PRIMARY, memberId: MEMBER, state: 'decided', cursor: null, limit: 20 });
    expect(r.ok && r.value.items.map((x) => x.request.id)).toEqual([R(3)]);
  });

  it('getPortalChangeRequest: in scope → the (projected) row; a colleague\'s own-contact request, another member\'s row and an unknown id → not_found', async () => {
    const { deps, repo } = makeDeps();
    const mine = await getPortalChangeRequest(deps, { changeRequestId: R(1) as ChangeRequestId, userId: PRIMARY, memberId: MEMBER });
    expect(mine.ok && mine.value.request.id).toBe(R(1));
    const mixedForSecondary = await getPortalChangeRequest(deps, { changeRequestId: R(3) as ChangeRequestId, userId: SECONDARY, memberId: MEMBER });
    expect(mixedForSecondary.ok && mixedForSecondary.value.request.fields.map((f) => f.key)).toEqual(['company_name']);
    expect(await getPortalChangeRequest(deps, { changeRequestId: R(1) as ChangeRequestId, userId: SECONDARY, memberId: MEMBER })).toEqual({ ok: false, error: { type: 'not_found' } });
    expect(await getPortalChangeRequest(deps, { changeRequestId: R(5) as ChangeRequestId, userId: PRIMARY, memberId: MEMBER })).toEqual({ ok: false, error: { type: 'not_found' } });
    expect(await getPortalChangeRequest(deps, { changeRequestId: R(9) as ChangeRequestId, userId: PRIMARY, memberId: MEMBER })).toEqual({ ok: false, error: { type: 'not_found' } });
    repo.failNext('findListRowById');
    const fault = await getPortalChangeRequest(deps, { changeRequestId: R(1) as ChangeRequestId, userId: PRIMARY, memberId: MEMBER });
    expect(!fault.ok && fault.error.type).toBe('server_error');
  });
});
