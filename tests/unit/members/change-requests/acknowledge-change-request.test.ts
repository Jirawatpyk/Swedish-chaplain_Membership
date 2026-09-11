/**
 * F114 T061 — `acknowledgeChangeRequest` (US3; FR-010 "dismiss a shown
 * decision"; contracts/portal-change-requests-api.md § acknowledge).
 *
 * Pinned: only the SUBMITTER may acknowledge (another user → `not_found`,
 * never a 403 that leaks existence); the request must be `decided`
 * (pending / withdrawn → `not_decided`); the stamp is idempotent (a second
 * call keeps the first `outcomeAcknowledgedAt`); NO audit event (a UI
 * preference, not a data change); repo faults → `server_error`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: true })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asContactId } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { acknowledgeChangeRequest } from '@/modules/members/application/use-cases/change-requests/acknowledge-change-request';
import { makeAuditPortFake, makeClockFake, makeInMemoryChangeRequestRepo } from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const SUBMITTER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const OTHER = 'a6c5b1a2-0000-4000-8000-00000000cccc' as UserId;
const REQ = '00000000-0000-4000-8000-000000000001' as ChangeRequestId;
const NOW = new Date('2026-09-11T10:00:00Z');
const LATER = new Date('2026-09-11T11:00:00Z');

function request(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: REQ,
    tenantId: 'test-tenant' as ChangeRequest['tenantId'],
    memberId: asMemberId('11111111-1111-4111-8111-111111111111'),
    submittedByUserId: SUBMITTER,
    submittedByContactId: asContactId('22222222-2222-4222-8222-222222222222'),
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
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [{ key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'rejected', appliedAt: null }],
    ...overrides,
  };
}

function makeDeps(row: ChangeRequest = request()) {
  const repo = makeInMemoryChangeRequestRepo([row]);
  const audit = makeAuditPortFake();
  const clock = makeClockFake(NOW);
  return { deps: { tenant, changeRequestRepo: repo, audit, clock }, repo, audit, clock };
}

beforeEach(() => vi.clearAllMocks());

describe('acknowledgeChangeRequest', () => {
  it('the submitter dismisses a decided request → outcomeAcknowledgedAt stamped; no audit row', async () => {
    const { deps, repo, audit } = makeDeps();
    const r = await acknowledgeChangeRequest(deps, { changeRequestId: REQ, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' });
    expect(r.ok && r.value.request.outcomeAcknowledgedAt).toEqual(NOW);
    expect(repo.rows.get(REQ)?.outcomeAcknowledgedAt).toEqual(NOW);
    expect(audit.events).toHaveLength(0);
    expect(audit.recordInTx).not.toHaveBeenCalled();
  });

  it('a second call is idempotent — the first stamp is kept', async () => {
    const { deps, clock } = makeDeps();
    await acknowledgeChangeRequest(deps, { changeRequestId: REQ, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' });
    clock.set(LATER);
    const again = await acknowledgeChangeRequest(deps, { changeRequestId: REQ, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' });
    expect(again.ok && again.value.request.outcomeAcknowledgedAt).toEqual(NOW);
  });

  it('another user (another contact of the same member) → not_found, nothing stamped — and NOT a cross-tenant probe (the row is visible in-tenant)', async () => {
    const { deps, repo, audit } = makeDeps();
    expect(await acknowledgeChangeRequest(deps, { changeRequestId: REQ, actorUserId: OTHER, actorRole: 'member', requestId: 'req-ack' })).toEqual({ ok: false, error: { type: 'not_found' } });
    expect(repo.rows.get(REQ)?.outcomeAcknowledgedAt).toBeNull();
    expect(audit.events).toHaveLength(0);
  });

  it('a repo miss (unknown id, or another tenant\'s row hidden by RLS) → not_found + a member_cross_tenant_probe audit', async () => {
    const { deps, audit } = makeDeps();
    const id = '00000000-0000-4000-8000-0000000000ff' as ChangeRequestId;
    expect(await acknowledgeChangeRequest(deps, { changeRequestId: id, actorUserId: OTHER, actorRole: 'member', requestId: 'req-ack' })).toEqual({ ok: false, error: { type: 'not_found' } });
    expect(audit.events).toEqual([
      expect.objectContaining({
        type: 'member_cross_tenant_probe',
        actorUserId: OTHER,
        payload: { attempted_change_request_id: id, actor_tenant_id: 'test-tenant', action: 'acknowledge', actor_role: 'member' },
      }),
    ]);
  });

  it('an unknown id → not_found', async () => {
    const { deps } = makeDeps();
    expect(await acknowledgeChangeRequest(deps, { changeRequestId: '00000000-0000-4000-8000-0000000000ff' as ChangeRequestId, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' })).toEqual({
      ok: false,
      error: { type: 'not_found' },
    });
  });

  it('pending / withdrawn → not_decided', async () => {
    const pending = makeDeps(request({ state: 'pending', outcome: null, decidedAt: null, decidedByUserId: null, decisionReason: null }));
    expect(await acknowledgeChangeRequest(pending.deps, { changeRequestId: REQ, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' })).toEqual({ ok: false, error: { type: 'not_decided' } });
    const withdrawn = makeDeps(request({ state: 'withdrawn', outcome: null, decidedAt: null, decidedByUserId: null, decisionReason: null, withdrawnReason: 'member', withdrawnAt: NOW }));
    expect(await acknowledgeChangeRequest(withdrawn.deps, { changeRequestId: REQ, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' })).toEqual({ ok: false, error: { type: 'not_decided' } });
  });

  it('repo faults → server_error (read and write)', async () => {
    const a = makeDeps();
    a.repo.failNext('findByIdInTx');
    expect(await acknowledgeChangeRequest(a.deps, { changeRequestId: REQ, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' })).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const b = makeDeps();
    b.repo.failNext('acknowledgeInTx');
    expect(await acknowledgeChangeRequest(b.deps, { changeRequestId: REQ, actorUserId: SUBMITTER, actorRole: 'member', requestId: 'req-ack' })).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });
});
