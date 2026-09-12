/**
 * F114 T060 — contract: `POST /api/portal/change-requests/[id]/acknowledge`
 * (contracts/portal-change-requests-api.md § acknowledge; FR-010, FR-039).
 *
 * The REAL `acknowledgeChangeRequest` runs over the in-memory fake (the
 * composition root is mocked; `runInTenant` passes through): submitter → 200
 * with `outcomeAcknowledgedAt` in the portal view (decidedBy is the literal
 * "organisation"); a second call is idempotent; another contact → 404 (no
 * existence leak); pending → 409 `not_decided`; NO audit row; flag OFF → 404
 * before the member context; a staff session gets the member-context refusal;
 * a malformed id → 404; a repo fault → 500 named `M114.portal.acknowledge.*`.
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

import { POST } from '@/app/api/portal/change-requests/[id]/acknowledge/route';

const NOW = new Date('2026-09-11T10:00:00Z');
const MEMBER = '11111111-1111-4111-8111-111111111111';
const CONTACT = '22222222-2222-4222-8222-222222222222';
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb';
const OTHER_CONTACT = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = 'a6c5b1a2-0000-4000-8000-00000000cccc';
const REQ = '00000000-0000-4000-8000-000000000001';

const memberContext = (userId: string, contactId: string) => ({
  current: { user: { id: userId, email: 'anna@nordic.example', role: 'member', status: 'active' }, session: { id: 's-1' } },
  tenant: { slug: 'test-swecham', __brand: true },
  member: { memberId: MEMBER, companyName: 'Nordic Co', status: 'active' },
  memberId: MEMBER,
  ownContact: { contactId, memberId: MEMBER, firstName: 'Anna', lastName: 'Svensson', isPrimary: true },
  ownContactId: contactId,
  sourceIp: '127.0.0.1',
  requestId: 'req-ack-1',
});

function decided(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: REQ as ChangeRequestId,
    tenantId: 'test-swecham' as ChangeRequest['tenantId'],
    memberId: MEMBER as ChangeRequest['memberId'],
    submittedByUserId: SUBMITTER as UserId,
    submittedByContactId: CONTACT as ChangeRequest['submittedByContactId'],
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'decided',
    outcome: 'rejected',
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: new Date('2026-09-11T08:00:00Z'),
    staffNotifiedAt: null,
    decidedAt: new Date('2026-09-11T09:00:00Z'),
    decidedByUserId: 'a6c5b1a2-0000-4000-8000-00000000aaaa' as UserId,
    decisionReason: 'Use the registered phone',
    decisionNote: 'internal',
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'rejected', appliedAt: null }],
    ...overrides,
  };
}

function call(id = REQ): Promise<Response> {
  const request = new NextRequest(`http://localhost/api/portal/change-requests/${id}/acknowledge`, { method: 'POST' });
  return POST(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  flagOn = true;
  readOnly = false;
  repo = makeInMemoryChangeRequestRepo([decided()]);
  audit = makeAuditPortFake();
  requireMemberContextMock.mockResolvedValue(memberContext(SUBMITTER, CONTACT));
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/portal/change-requests/[id]/acknowledge', () => {
  it('404 while the flag is off — before the member context', async () => {
    flagOn = false;
    expect((await call()).status).toBe(404);
    expect(requireMemberContextMock).not.toHaveBeenCalled();
  });

  it('a staff session gets the member-context refusal', async () => {
    requireMemberContextMock.mockResolvedValueOnce({ response: Response.json({ error: 'forbidden' }, { status: 403 }) });
    expect((await call()).status).toBe(403);
  });

  it('the submitter → 200 with the portal view carrying outcomeAcknowledgedAt; decidedBy is "organisation"; the note is never exposed; no audit', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request).toMatchObject({ id: REQ, state: 'decided', outcome: 'rejected', decidedBy: 'organisation', outcomeAcknowledgedAt: NOW.toISOString(), decisionReason: 'Use the registered phone' });
    expect(body.request).not.toHaveProperty('decisionNote');
    expect(body.request).not.toHaveProperty('decidedByUserId');
    expect(JSON.stringify(body)).not.toContain('a6c5b1a2-0000-4000-8000-00000000aaaa');
    expect(audit.events).toHaveLength(0);
  });

  it('a second call is idempotent — same stamp, still 200', async () => {
    const first = await (await call()).json();
    const second = await (await call()).json();
    expect(second.request.outcomeAcknowledgedAt).toBe(first.request.outcomeAcknowledgedAt);
  });

  it('another contact of the same member → 404 (never 403); nothing stamped', async () => {
    requireMemberContextMock.mockResolvedValue(memberContext(OTHER_USER, OTHER_CONTACT));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(repo.rows.get(REQ)?.outcomeAcknowledgedAt).toBeNull();
  });

  it('a pending request → 409 not_decided', async () => {
    repo = makeInMemoryChangeRequestRepo([decided({ state: 'pending', outcome: null, decidedAt: null, decidedByUserId: null, decisionReason: null, decisionNote: null })]);
    const res = await call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_decided' });
  });

  it('a malformed id → 404; an unknown id → 404', async () => {
    expect((await call('nope')).status).toBe(404);
    expect((await call('00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
  });

  it('READ_ONLY_MODE → 503 read_only_mode after the member context, nothing stamped (FR-036 / T116)', async () => {
    readOnly = true;
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('5');
    expect(await res.json()).toMatchObject({ error: { code: 'read_only_mode' } });
    expect(requireMemberContextMock).toHaveBeenCalled();
    expect(repo.rows.get(REQ)?.outcomeAcknowledgedAt).toBeNull();
  });

  it('a repo fault → 500 named in the errorId taxonomy', async () => {
    repo.failNext('acknowledgeInTx');
    const res = await call();
    expect(res.status).toBe(500);
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ errorId: 'M114.portal.acknowledge.use_case_failed' }), expect.any(String));
  });
});
