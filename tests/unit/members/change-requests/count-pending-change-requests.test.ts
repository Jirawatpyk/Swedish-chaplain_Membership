/**
 * F114 T095 — `countPendingChangeRequests` (US6 AS3; FR-033, FR-037;
 * research R12): `pendingStats` → `{ count, oldestAgeSeconds }`.
 *
 * Pinned: `oldestAgeSeconds` is computed from the injected `ClockPort`,
 * never `Date.now()`; it is `null` when nothing is pending (the same
 * semantics as `listChangeRequestQueue`'s `oldestPendingAgeSeconds` — an
 * absent age is not a zero-second age, and the nav / dashboard render
 * nothing for `null`); a future-dated `submittedAt` (clock skew) clamps to
 * 0; whole seconds, floored; a repo fault → `server_error`, logged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, runInTenant: vi.fn() }));
const loggerError = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asContactId } from '@/modules/members';
import type { UserId } from '@/modules/members/domain/value-objects/user-id';
import type { ChangeRequest, ChangeRequestId } from '@/modules/members/domain/change-request/change-request';
import { countPendingChangeRequests } from '@/modules/members/application/use-cases/change-requests/count-pending-change-requests';
import { makeClockFake, makeInMemoryChangeRequestRepo } from '../../../helpers/change-request-fakes';

const tenant = asTenantContext('test-tenant');
const MEMBER = asMemberId('11111111-1111-4111-8111-111111111111');
const CONTACT = asContactId('22222222-2222-4222-8222-222222222222');
const USER = 'a6c5b1a2-0000-4000-8000-00000000bbbb' as UserId;
const OTHER = 'a6c5b1a2-0000-4000-8000-00000000cccc' as UserId;
const NOW = new Date('2026-09-15T10:00:00Z');

function request(id: string, submittedAt: Date, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: id as ChangeRequestId,
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
    submittedAt,
    staffNotifiedAt: submittedAt,
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

const R = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);

function makeDeps(seed: readonly ChangeRequest[]) {
  const repo = makeInMemoryChangeRequestRepo(seed);
  const clock = makeClockFake(NOW);
  return { deps: { tenant, changeRequestRepo: repo, clock }, repo, clock };
}

beforeEach(() => vi.clearAllMocks());

describe('countPendingChangeRequests', () => {
  it('nothing pending → { count: 0, oldestAgeSeconds: null } (an absent age, not a zero age)', async () => {
    const { deps } = makeDeps([]);
    await expect(countPendingChangeRequests(deps)).resolves.toEqual({ ok: true, value: { count: 0, oldestAgeSeconds: null } });
  });

  it('counts PENDING rows only and ages the OLDEST pending one from the injected clock, floored to whole seconds', async () => {
    const { deps } = makeDeps([
      request(R(1), secondsAgo(90.9)),
      request(R(2), secondsAgo(3600), { submittedByUserId: OTHER }),
      // decided / withdrawn rows are older still and must not count
      request(R(3), secondsAgo(86_400), { state: 'decided', outcome: 'approved', decidedAt: NOW, decidedByUserId: OTHER }),
      request(R(4), secondsAgo(172_800), { state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: NOW }),
    ]);
    await expect(countPendingChangeRequests(deps)).resolves.toEqual({ ok: true, value: { count: 2, oldestAgeSeconds: 3600 } });
  });

  it('reads the clock at call time — never Date.now()', async () => {
    const { deps, clock } = makeDeps([request(R(1), secondsAgo(60))]);
    const realNow = vi.spyOn(Date, 'now');
    clock.set(new Date(NOW.getTime() + 40_000));
    const r = await countPendingChangeRequests(deps);
    expect(r).toEqual({ ok: true, value: { count: 1, oldestAgeSeconds: 100 } });
    expect(realNow).not.toHaveBeenCalled();
    realNow.mockRestore();
  });

  it('a submittedAt in the future (clock skew) clamps to 0, never negative', async () => {
    const { deps } = makeDeps([request(R(1), new Date(NOW.getTime() + 5000))]);
    await expect(countPendingChangeRequests(deps)).resolves.toEqual({ ok: true, value: { count: 1, oldestAgeSeconds: 0 } });
  });

  it('a repo fault → server_error, logged', async () => {
    const { deps, repo } = makeDeps([request(R(1), secondsAgo(60))]);
    repo.failNext('pendingStats');
    const r = await countPendingChangeRequests(deps);
    expect(r).toEqual({ ok: false, error: { type: 'server_error', message: 'count-pending: repo.unexpected' } });
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'test-tenant', err: 'repo.unexpected' }), expect.stringMatching(/count-pending/));
  });
});
