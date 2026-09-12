/**
 * F114 T078 — `eraseMember` step 2 calls the change-request scrub INSIDE the
 * atomic scrub tx and records the erasure closures (FR-025, FR-030; research
 * R10). Over the stubbed erase deps (`erase-member.fixtures.ts`):
 *   - `changeRequestScrub.scrubForMemberInTx(tx, memberId, now)` runs in the
 *     same tx as the member + contact scrubs and is the FIRST lock the tx
 *     takes — BEFORE the member row's `FOR UPDATE` — so every F114 path locks
 *     in the same order (request rows → member row) as `submitChangeRequest`
 *     and `decideChangeRequest`, and an erasure racing a submit cannot
 *     deadlock (review round 1, REL-1: AB-BA inversion);
 *   - one `member_change_request_withdrawn` audit row per CLOSED (formerly
 *     pending) request: `{ related_member_id, request_id, contact_id, scope,
 *     withdrawn_reason: 'erasure', actor_role: 'system' }` attributed to the
 *     erasure's actor — `related_member_id` (never `member_id`: a system
 *     closure is not member activity, the recency trigger must not fire) and
 *     `actor_role: 'system'` (the closure is the erasure's consequence, not a
 *     human decision — the #333 kill-switch precedent);
 *   - a scrubbed-but-not-closed (decided) request emits nothing;
 *   - the pending outbox rows keyed on the member (`cancelPendingForMemberInTx`)
 *     are cancelled in the same tx;
 *   - a scrub failure, an audit failure or an outbox-cancel failure aborts
 *     the tx (server_error) and `member_erased` is never emitted.
 */
import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/lib/result';

vi.mock('@/lib/db', () => ({
  db: {},
  runInTenant: vi.fn(async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ __tx: 'scrub-tx' })),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
import { eraseMember } from '@/modules/members/application/use-cases/erase-member';
import { asMemberId } from '@/modules/members';
import { buildEraseDeps } from './erase-member.fixtures';

// the fixtures' FAKE_MEMBER is `m-1`; the actor is the admin who clicked erase
const MEMBER_ID = 'm-1';
const META = { actorUserId: 'admin-1', requestId: 'req-erase-1' };

const CLOSED = [
  { id: '00000000-0000-4000-8000-000000000001', contactId: '22222222-2222-4222-8222-222222222222', scope: 'own_contact' as const },
  { id: '00000000-0000-4000-8000-000000000002', contactId: '22222222-2222-4222-8222-333333333333', scope: 'company' as const },
];

const SCRUBBED_IDS = [...CLOSED.map((c) => c.id), '00000000-0000-4000-8000-000000000003'];

function deps(overrides: { scrub?: () => Promise<unknown>; rescan?: () => Promise<unknown>; cancel?: () => Promise<unknown> } = {}) {
  const d = buildEraseDeps();
  d.changeRequestScrub = {
    scrubForMemberInTx: vi.fn(overrides.scrub ?? (async () => ok({ scrubbedRequestIds: SCRUBBED_IDS, closedRequests: CLOSED }))) as ReturnType<typeof vi.fn>,
    listRequestIdsInTx: vi.fn(overrides.rescan ?? (async () => ok(SCRUBBED_IDS))) as ReturnType<typeof vi.fn>,
  };
  d.outboxCancel.cancelPendingForMemberInTx = vi.fn(overrides.cancel ?? (async () => ok({ cancelledCount: 2 }))) as ReturnType<typeof vi.fn>;
  return d;
}

describe('eraseMember — change-request scrub (F114 T078)', () => {
  it('scrubs inside the atomic tx BEFORE the member row lock (request rows → member row, the submit / decide order), records one erasure closure per closed request, cancels the member-keyed outbox rows', async () => {
    const d = deps();
    const res = await eraseMember(asMemberId(MEMBER_ID), { reason: 'gdpr_erasure_request' }, META, d);
    expect(res.ok, JSON.stringify(res)).toBe(true);

    expect(d.changeRequestScrub.scrubForMemberInTx).toHaveBeenCalledTimes(1);
    const [tx, memberArg, at] = d.changeRequestScrub.scrubForMemberInTx.mock.calls[0]!;
    expect(tx).toEqual({ __tx: 'scrub-tx' });
    expect(memberArg).toBe(MEMBER_ID);
    expect(at).toBeInstanceOf(Date);
    const memberLockOrder = d.memberRepo.findByIdInTx.mock.invocationCallOrder[0]!;
    const crScrubOrder = d.changeRequestScrub.scrubForMemberInTx.mock.invocationCallOrder[0]!;
    expect(crScrubOrder).toBeLessThan(memberLockOrder);

    const events = d.audit.recordInTx.mock.calls.map((c) => c[2] as { type: string; actorUserId: string; requestId: string; payload: Record<string, unknown> });
    const closures = events.filter((e) => e.type === 'member_change_request_withdrawn');
    expect(closures).toHaveLength(2);
    expect(closures[0]).toMatchObject({
      actorUserId: META.actorUserId,
      requestId: META.requestId,
      payload: { related_member_id: MEMBER_ID, request_id: CLOSED[0]!.id, contact_id: CLOSED[0]!.contactId, scope: 'own_contact', withdrawn_reason: 'erasure', actor_role: 'system' },
    });
    expect(closures[1]!.payload).toMatchObject({ request_id: CLOSED[1]!.id, scope: 'company', withdrawn_reason: 'erasure' });
    for (const c of closures) {
      expect(c.payload).not.toHaveProperty('member_id');
      expect(c.payload).not.toHaveProperty('reason');
    }
    // the closures are written in the SAME tx
    for (const call of d.audit.recordInTx.mock.calls) expect(call[0]).toEqual({ __tx: 'scrub-tx' });

    expect(d.outboxCancel.cancelPendingForMemberInTx).toHaveBeenCalledWith({ __tx: 'scrub-tx' }, MEMBER_ID);
  });

  it('a request INSERTED between the id snapshot and the member lock (a submit that got in first) aborts the erase → server_error, nothing committed (seam re-review, #1)', async () => {
    // the scrub's FOR UPDATE snapshot cannot see a row inserted after the
    // statement started; a submit holding the pending row first can commit a
    // replacement before the erase reaches the member lock
    const d = deps({ rescan: async () => ok([...SCRUBBED_IDS, '00000000-0000-4000-8000-000000000099']) });
    const res = await eraseMember(asMemberId(MEMBER_ID), { reason: 'gdpr_erasure_request' }, META, d);
    expect(res).toMatchObject({ ok: false, error: { type: 'server_error' } });
    // the rescan runs AFTER the member row lock — that is the whole point
    expect(d.changeRequestScrub.listRequestIdsInTx.mock.invocationCallOrder[0]!).toBeGreaterThan(d.memberRepo.findByIdInTx.mock.invocationCallOrder[0]!);
    expect(d.memberRepo.scrubPiiInTx).not.toHaveBeenCalled();
    expect(d.contactRepo.scrubPiiForMemberInTx).not.toHaveBeenCalled();
    const types = d.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(types).not.toContain('member_erased');
  });

  it('a member with no pending request emits no closure', async () => {
    const d = deps({
      scrub: async () => ok({ scrubbedRequestIds: ['00000000-0000-4000-8000-000000000003'], closedRequests: [] }),
      rescan: async () => ok(['00000000-0000-4000-8000-000000000003']),
    });
    const res = await eraseMember(asMemberId(MEMBER_ID), { reason: 'gdpr_erasure_request' }, META, d);
    expect(res.ok).toBe(true);
    const closures = d.audit.recordInTx.mock.calls.filter((c) => (c[2] as { type: string }).type === 'member_change_request_withdrawn');
    expect(closures).toHaveLength(0);
  });

  it.each([
    ['scrub', { scrub: async () => err({ code: 'repo.unexpected' as const, cause: new Error('boom') }) }],
    ['outbox cancel', { cancel: async () => err({ code: 'repo.unexpected' as const, cause: new Error('boom') }) }],
  ])('a %s failure aborts the scrub tx → server_error, member_erased never emitted', async (_label, overrides) => {
    const d = deps(overrides);
    const res = await eraseMember(asMemberId(MEMBER_ID), { reason: 'gdpr_erasure_request' }, META, d);
    expect(res).toMatchObject({ ok: false, error: { type: 'server_error' } });
    const types = d.audit.recordInTx.mock.calls.map((c) => (c[2] as { type: string }).type);
    expect(types).not.toContain('member_erased');
  });

  it('an audit failure on a closure aborts the tx → server_error', async () => {
    const d = deps();
    d.audit.recordInTx = vi.fn(async (_tx: unknown, _ctx: unknown, event: { type: string }) =>
      event.type === 'member_change_request_withdrawn' ? err({ code: 'repo.unexpected' as const, cause: new Error('audit down') }) : ok(undefined),
    );
    const res = await eraseMember(asMemberId(MEMBER_ID), { reason: 'gdpr_erasure_request' }, META, d);
    expect(res).toMatchObject({ ok: false, error: { type: 'server_error' } });
  });
});
