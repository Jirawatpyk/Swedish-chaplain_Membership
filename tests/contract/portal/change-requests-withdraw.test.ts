/**
 * F114 T082 — contract: `DELETE /api/portal/change-requests/current` — withdraw
 * (contracts/portal-change-requests-api.md § withdraw; US5 AS1; FR-009,
 * FR-036, FR-039).
 *
 * The REAL `withdrawChangeRequest` runs over the in-memory fakes (the
 * composition root is mocked; `runInTenant` passes through): the caller's
 * own pending request → 200 with the portal view (`withdrawn/member`) + ONE
 * audit row `member_change_request_withdrawn { member_id, request_id,
 * contact_id, scope, withdrawn_reason: 'member' }`; a second call → 404
 * `no_pending_request`; a different contact's pending request is untouched
 * either way; a staff session gets the member-context refusal; flag OFF →
 * 404 before the member context; READ_ONLY_MODE → 503 after the member
 * context, nothing written (T116); a repo fault → 500 named
 * `M114.portal.withdraw.use_case_failed`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { makeAuditPortFake, makeClockFake, makeInMemoryChangeRequestRepo, type AuditPortFake, type InMemoryChangeRequestRepo } from '../../helpers/change-request-fakes';

const requireMemberContextMock = vi.fn();
const loggerError = vi.fn();
let flagOn = true;
let readOnly = false;
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
      flags: new Proxy(actual.env.flags, {
        get: (target, prop) => (prop === 'readOnlyMode' ? readOnly : Reflect.get(target, prop)),
      }),
    },
  };
});
vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
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

import { DELETE } from '@/app/api/portal/change-requests/current/route';

const NOW = new Date('2026-09-11T10:00:00Z');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const OTHER_CONTACT = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = 'a6c5b1a2-0000-4000-8000-00000000cccc';
const REQ = '00000000-0000-4000-8000-000000000001';
const OTHER_REQ = '00000000-0000-4000-8000-000000000002';

const memberContext = (userId: string, contactId: string) => ({
  current: { user: { id: userId, email: 'anna@nordic.example', role: 'member', status: 'active' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: { memberId: MEMBER, companyName: 'Nordic Co', status: 'active' },
  memberId: MEMBER,
  ownContact: { contactId, memberId: MEMBER, firstName: 'Anna', lastName: 'Svensson', isPrimary: true },
  ownContactId: contactId,
  sourceIp: '127.0.0.1',
  requestId: 'req-wd-1',
});

function pending(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: REQ as ChangeRequestId,
    tenantId: 'test-swecham' as ChangeRequest['tenantId'],
    memberId: MEMBER as ChangeRequest['memberId'],
    submittedByUserId: SUBMITTER as UserId,
    submittedByContactId: CONTACT as ChangeRequest['submittedByContactId'],
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'pending',
    outcome: null,
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: new Date('2026-09-11T08:00:00Z'),
    staffNotifiedAt: new Date('2026-09-11T08:00:00Z'),
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

const otherPending = () => pending({ id: OTHER_REQ as ChangeRequestId, submittedByUserId: OTHER_USER as UserId, submittedByContactId: OTHER_CONTACT as ChangeRequest['submittedByContactId'] });

function call(): Promise<Response> {
  const request = new NextRequest('http://localhost/api/portal/change-requests/current', { method: 'DELETE' });
  return DELETE(request);
}

beforeEach(() => {
  flagOn = true;
  readOnly = false;
  repo = makeInMemoryChangeRequestRepo([pending(), otherPending()]);
  audit = makeAuditPortFake();
  requireMemberContextMock.mockResolvedValue(memberContext(SUBMITTER, CONTACT));
});
afterEach(() => vi.clearAllMocks());

describe('DELETE /api/portal/change-requests/current', () => {
  it('404 while the flag is off — before the member context (FR-039)', async () => {
    flagOn = false;
    expect((await call()).status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
  });

  it('a staff session gets the member-context refusal', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(repo.rows.get(REQ)?.state).toBe('pending');
  });

  it("200: the caller's pending request is withdrawn/member in the portal view; ONE audit row keyed member_id; the colleague's request untouched", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request).toMatchObject({ id: REQ, state: 'withdrawn', withdrawnReason: 'member', decidedBy: 'organisation', submittedBy: { contactId: CONTACT, isMe: true } });
    expect(body.request).not.toHaveProperty('decisionNote');
    expect(repo.rows.get(REQ)).toMatchObject({ state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: NOW });
    expect(repo.rows.get(OTHER_REQ)?.state).toBe('pending');
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'member_change_request_withdrawn',
      actorUserId: SUBMITTER,
      requestId: 'req-wd-1',
      payload: { member_id: MEMBER, request_id: REQ, contact_id: CONTACT, scope: 'own_contact', withdrawn_reason: 'member', actor_role: 'member' },
    });
    expect(JSON.stringify(audit.events[0]!.payload)).not.toContain('+668');
  });

  it('a second call → 404 no_pending_request (idempotent: nothing else changes, no second audit)', async () => {
    expect((await call()).status).toBe(200);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no_pending_request' });
    expect(audit.events).toHaveLength(1);
    expect(repo.rows.get(OTHER_REQ)?.state).toBe('pending');
  });

  it("a caller with no pending request → 404 no_pending_request; a colleague's pending request is never the one withdrawn", async () => {
    requireMemberContextMock.mockResolvedValue(memberContext('a6c5b1a2-0000-4000-8000-00000000dddd', '44444444-4444-4444-8444-444444444444'));
    const res = await call();
    expect(res.status).toBe(404);
    expect(repo.rows.get(REQ)?.state).toBe('pending');
    expect(repo.rows.get(OTHER_REQ)?.state).toBe('pending');
    expect(audit.events).toHaveLength(0);
  });

  it('READ_ONLY_MODE → 503 read_only_mode after the member context, nothing withdrawn (FR-036 / T116)', async () => {
    readOnly = true;
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toMatchObject({ error: { code: 'read_only_mode' } });
    expect(requireMemberContextMock).toHaveBeenCalled();
    expect(repo.rows.get(REQ)?.state).toBe('pending');
  });

  it('a repo fault → 500 named in the errorId taxonomy', async () => {
    repo.failNext('withdrawInTx', { code: 'repo.unexpected' });
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'server_error' });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.portal.withdraw.use_case_failed' }), expect.any(String));
  });
});
