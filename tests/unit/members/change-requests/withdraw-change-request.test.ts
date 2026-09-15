/**
 * F114 T085 — `withdrawChangeRequest`, every branch (US5 AS1; FR-009,
 * FR-017, FR-025; contracts/portal-change-requests-api.md § withdraw).
 *
 * Pinned: only the caller's OWN pending request is withdrawn (found by the
 * submitter's user id — never by a body id); it becomes `withdrawn/member`
 * with `withdrawnAt = now` and ONE audit row
 * `member_change_request_withdrawn { member_id, request_id, contact_id,
 * scope, withdrawn_reason: 'member', actor_role }` — `member_id` (snake_case)
 * because a withdrawal IS member activity (the 0009 recency trigger key);
 * no pending request → `no_pending_request` and no audit; a decision that
 * committed between the read and the write (the repo's `WHERE state =
 * 'pending'` matched nothing) → `no_pending_request` too (FR-017 "first
 * committed transition wins"); another person's pending request is never
 * touched; every fault → `server_error`, logged.
 *
 * `runInTenant` is stubbed (unit level); the live-Neon half rides in
 * tests/integration/members/change-requests-rate-cap.test.ts (T084).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
const loggerError = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/metrics', () => ({
  membersMetrics: {
    changeRequests: {
      refused: vi.fn(),
      submitted: vi.fn(),
      decided: vi.fn(),
      decideDurationMs: vi.fn(),
      pendingCount: vi.fn(),
      oldestAgeSeconds: vi.fn(),
    },
  },
}));

import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asContactId } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { withdrawChangeRequest } from '@/modules/members/application/use-cases/change-requests/withdraw-change-request';
import { makeAuditPortFake, makeClockFake, makeInMemoryChangeRequestRepo } from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const CONTACT = asContactId('22222222-2222-4222-8222-222222222222');
const OTHER_CONTACT = asContactId('22222222-2222-4222-8222-333333333333');
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const OTHER = 'a6c5b1a2-0000-4000-8000-00000000cccc' as UserId;
const REQ = '00000000-0000-4000-8000-000000000001' as ChangeRequestId;
const OTHER_REQ = '00000000-0000-4000-8000-000000000002' as ChangeRequestId;
const SUBMITTED_AT = new Date('2026-09-11T08:00:00Z');
const NOW = new Date('2026-09-11T10:00:00Z');

function pending(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: REQ,
    tenantId: 'test-tenant' as ChangeRequest['tenantId'],
    memberId: MEMBER,
    submittedByUserId: USER,
    submittedByContactId: CONTACT,
    submitterRoleAtSubmission: 'primary',
    scope: 'own_contact',
    state: 'pending',
    outcome: null,
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: SUBMITTED_AT,
    staffNotifiedAt: SUBMITTED_AT,
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

function makeDeps(seed: readonly ChangeRequest[] = [pending()]) {
  const repo = makeInMemoryChangeRequestRepo(seed);
  const audit = makeAuditPortFake();
  const deps = { tenant, changeRequestRepo: repo, audit, clock: makeClockFake(NOW) };
  return { deps, repo, audit };
}

const input = { actorUserId: USER, actorRole: 'member', requestId: 'req-w1' };

beforeEach(() => vi.clearAllMocks());

describe('withdrawChangeRequest', () => {
  it("withdraws the caller's OWN pending request: withdrawn/member, withdrawnAt = now, one audit row keyed member_id (member activity)", async () => {
    const { deps, repo, audit } = makeDeps();
    const r = await withdrawChangeRequest(deps, input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.request).toMatchObject({ id: REQ, state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: NOW, replacedByRequestId: null });
    expect(repo.rows.get(REQ)).toMatchObject({ state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: NOW });
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      type: 'member_change_request_withdrawn',
      actorUserId: USER,
      requestId: 'req-w1',
      payload: {
        member_id: MEMBER,
        request_id: REQ,
        contact_id: CONTACT,
        scope: 'own_contact',
        withdrawn_reason: 'member',
        actor_role: 'member',
      },
    });
    // the audit was written INSIDE the tx (rollback-safe), never `record`
    expect(audit.recordInTx).toHaveBeenCalledTimes(1);
    expect(audit.record).not.toHaveBeenCalled();
    // ids only — no value, no bare `reason` key (the F9 redaction deny-list), no related_member_id
    const payload = audit.events[0]!.payload;
    expect(payload).not.toHaveProperty('reason');
    expect(payload).not.toHaveProperty('related_member_id');
    expect(JSON.stringify(payload)).not.toContain('+668');
  });

  it('no pending request → no_pending_request, nothing written, no audit', async () => {
    const { deps, repo, audit } = makeDeps([]);
    const r = await withdrawChangeRequest(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'no_pending_request' } });
    expect(repo.rows.size).toBe(0);
    expect(audit.events).toHaveLength(0);
  });

  it("a decided request is not pending — no_pending_request (a decision is final; FR-017)", async () => {
    const { deps, audit } = makeDeps([
      pending({ state: 'decided', outcome: 'approved', decidedAt: NOW, decidedByUserId: OTHER, fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'approved', appliedAt: NOW }] }),
    ]);
    const r = await withdrawChangeRequest(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'no_pending_request' } });
    expect(audit.events).toHaveLength(0);
  });

  it("another person's pending request is never touched — the caller without one gets no_pending_request", async () => {
    const { deps, repo, audit } = makeDeps([pending({ id: OTHER_REQ, submittedByUserId: OTHER, submittedByContactId: OTHER_CONTACT })]);
    const r = await withdrawChangeRequest(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'no_pending_request' } });
    expect(repo.rows.get(OTHER_REQ)?.state).toBe('pending');
    expect(audit.events).toHaveLength(0);
  });

  it("withdrawing one's own request leaves a colleague's pending request pending (two contacts of one member)", async () => {
    const { deps, repo } = makeDeps([pending(), pending({ id: OTHER_REQ, submittedByUserId: OTHER, submittedByContactId: OTHER_CONTACT, scope: 'own_contact' })]);
    const r = await withdrawChangeRequest(deps, input);
    expect(r.ok).toBe(true);
    expect(repo.rows.get(REQ)?.state).toBe('withdrawn');
    expect(repo.rows.get(OTHER_REQ)?.state).toBe('pending');
  });

  it('the write matching zero rows (a decision committed between the read and the UPDATE) → no_pending_request, no audit (FR-017)', async () => {
    const { deps, repo, audit } = makeDeps();
    // the fake's FOR UPDATE read returns the row; the UPDATE then finds it no longer pending
    repo.failNext('withdrawInTx', { code: 'repo.not_found' });
    const r = await withdrawChangeRequest(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'no_pending_request' } });
    expect(audit.events).toHaveLength(0);
  });

  it('a fault on the pending read → server_error, logged', async () => {
    const { deps, repo } = makeDeps();
    repo.failNext('findPendingBySubmitterInTx');
    const r = await withdrawChangeRequest(deps, input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.type).toBe('server_error');
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'test-tenant', requestId: 'req-w1', err: 'repo.unexpected' }), expect.stringMatching(/withdraw/));
  });

  it('a fault on the withdraw write → server_error, logged', async () => {
    const { deps, repo, audit } = makeDeps();
    repo.failNext('withdrawInTx', { code: 'repo.unexpected' });
    const r = await withdrawChangeRequest(deps, input);
    expect(!r.ok && r.error.type).toBe('server_error');
    expect(audit.events).toHaveLength(0);
    expect(loggerError).toHaveBeenCalled();
  });

  it('an audit write failure → server_error (the tx is aborted; the fake cannot roll back — atomicity is the live-Neon suite)', async () => {
    const { deps, audit } = makeDeps();
    audit.failNext();
    const r = await withdrawChangeRequest(deps, input);
    expect(!r.ok && r.error.type).toBe('server_error');
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ err: 'repo.unexpected' }), expect.any(String));
  });

  it('a throw that is not a repo error (the tx itself) → server_error naming the error class', async () => {
    const { deps, repo } = makeDeps();
    repo.findPendingBySubmitterInTx = async () => {
      throw new TypeError('connection reset');
    };
    const r = await withdrawChangeRequest(deps, input);
    expect(r).toEqual({ ok: false, error: { type: 'server_error', message: 'withdraw: TypeError' } });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ err: 'TypeError' }), expect.any(String));
  });
});
