/**
 * Spec 139 DE1 — the send-standing reader reads ERASURE first.
 *
 * Erasure takes a member OFF the halt list (`findMembersHaltedForBroadcast`
 * filters `erased_at IS NULL`), and F8 access can still answer `full` for an
 * erased member (a cancelled-not-expired, completed or missing cycle). So until
 * 139 an erased member's E-Blast read as "in good standing" at send time. The
 * reader now asks `getMemberErasedAt` BEFORE the halt list:
 *
 *   - erased, or no such member in the tenant (P4) → `erased`, and neither the
 *     halt list nor F8 access is read; a member not found carries
 *     `missing: true` (review round 2), so the send-time gate can tell the two
 *     apart;
 *   - the erasure read throws → `erasure_read_failed` (fail CLOSED);
 *   - a live member → the halt rule, then F8 access, as before.
 *
 * The send-time decision (`decideDispatchStanding`) maps `erased` to its own
 * permanent refusal, `refuse_erased`, which carries no standing-refusal audit
 * row (P3: the member-visible "membership suspended" event must never label an
 * erasure) and the existing `member_not_in_good_standing` failure token; a
 * failed erasure read is `undecided`. A requester NOT FOUND is `undecided` at
 * send time too (P4, maintainer 30 Oct 2026): nothing is sent, nothing is
 * deleted and the row stays `approved` — erasure never deletes a member row, so
 * a missing one is not evidence of an erasure. Submit, approve and
 * confirm-schedule keep refusing it (non-destructive).
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { readMemberSendStanding } from '@/modules/broadcasts/application/use-cases/_member-send-standing';
import {
  decideDispatchStanding,
  deleteDraftBeforeRefusal,
  deleteDraftBeforeStandingRefusal,
} from '@/modules/broadcasts/application/use-cases/_dispatch-standing-gate';
import { readDispatchHold } from '@/modules/broadcasts/application/use-cases/read-dispatch-hold';
import { makeFakeSendStanding } from '../../../helpers/eblast-approval-fakes';

const tenant = asTenantContext('test-tenant');

describe('readMemberSendStanding — erasure is read first (spec 139 DE1)', () => {
  it.each([
    ['erased', true, { kind: 'erased' }],
    // Review round 2 (P4) — `missing` tells the send-time gate it is not an erasure.
    ['not found in the tenant (P4)', 'not_found', { kind: 'erased', missing: true }],
  ] as const)('a member %s → erased; the halt list and F8 access are never read', async (_label, erased, expected) => {
    // Halted AND terminated too: erasure must win over both.
    const deps = makeFakeSendStanding({ erased, halted: ['m-1'], access: 'terminated' });
    expect(await readMemberSendStanding(deps, tenant, 'm-1')).toEqual(expected);
    expect(deps.membersBridge.getMemberErasedAt).toHaveBeenCalledWith(tenant, 'm-1');
    expect(deps.membersBridge.getMembersHaltedInTenant).not.toHaveBeenCalled();
    expect(deps.membershipAccess.getMembershipAccess).not.toHaveBeenCalled();
  });

  it('the erasure read throws → erasure_read_failed with the error class (fail closed), nothing else read', async () => {
    const deps = makeFakeSendStanding({ erased: 'throws' });
    expect(await readMemberSendStanding(deps, tenant, 'm-1')).toEqual({ kind: 'erasure_read_failed', errKind: 'Error' });
    expect(deps.membersBridge.getMembersHaltedInTenant).not.toHaveBeenCalled();
    expect(deps.membershipAccess.getMembershipAccess).not.toHaveBeenCalled();
  });

  it('a live member → the halt rule, then F8 access, exactly as before', async () => {
    const halted = makeFakeSendStanding({ halted: ['m-1'] });
    expect(await readMemberSendStanding(halted, tenant, 'm-1')).toEqual({ kind: 'halted' });
    expect(halted.membersBridge.getMemberErasedAt).toHaveBeenCalledTimes(1);
    const ok = makeFakeSendStanding();
    expect(await readMemberSendStanding(ok, tenant, 'm-1')).toEqual({ kind: 'ok' });
    expect(ok.membersBridge.getMembersHaltedInTenant).toHaveBeenCalledTimes(1);
    expect(ok.membershipAccess.getMembershipAccess).toHaveBeenCalledWith(tenant, 'm-1');
  });
});

describe('decideDispatchStanding — the send-time answer for an erased member (spec 139 DE1, P3)', () => {
  it('erased → refuse_erased (member_not_in_good_standing), no standing-refusal audit row to write', async () => {
    expect(await decideDispatchStanding(makeFakeSendStanding({ erased: true }), tenant, 'm-1')).toEqual({
      kind: 'refuse_erased',
      reason: 'member_not_in_good_standing',
    });
  });

  // Review round 2 (P4, maintainer 30 Oct 2026) — a requester not found is no
  // longer refused as erased at dispatch: no draft is deleted, no row turns
  // terminal, nothing is sent; the leg answers a server error (phase standing).
  it('a requester not found → undecided (requester_not_found): never refused, never a DELETE', async () => {
    expect(await decideDispatchStanding(makeFakeSendStanding({ erased: 'not_found' }), tenant, 'm-1')).toEqual({
      kind: 'undecided',
      message: 'member_standing_requester_not_found',
      errClass: 'requester_not_found',
    });
  });

  it('the erasure read throws → undecided (nothing is sent; the next tick asks again)', async () => {
    expect(await decideDispatchStanding(makeFakeSendStanding({ erased: 'throws' }), tenant, 'm-1')).toEqual({
      kind: 'undecided',
      message: 'member_standing_erasure_read_failed',
      errClass: 'Error',
    });
  });

  it('a halted member whose fresh re-read finds them erased → refuse_erased, never the halt refusal', async () => {
    const deps = makeFakeSendStanding({ halted: ['m-1'] });
    const fresh = makeFakeSendStanding({ erased: true });
    expect(
      await decideDispatchStanding({ ...deps, haltReadFresh: fresh.membersBridge }, tenant, 'm-1'),
    ).toEqual({ kind: 'refuse_erased', reason: 'member_not_in_good_standing' });
  });
});

describe('readDispatchHold — an erased member is never "held" (spec 139)', () => {
  const NOW = new Date('2026-09-25T05:00:00Z');
  const due = { status: 'approved' as const, scheduledFor: new Date(NOW.getTime() - 60_000), memberId: 'm-1' };

  it('erased → not held (the cron refuses it)', async () => {
    const r = await readDispatchHold({ tenant, sendStanding: makeFakeSendStanding({ erased: true }), clock: { now: () => NOW } }, due);
    expect(r).toEqual({ ok: true, value: false });
  });

  it('a requester not found → server_error (requester_not_found), never "held" (the page shows no note)', async () => {
    const r = await readDispatchHold(
      { tenant, sendStanding: makeFakeSendStanding({ erased: 'not_found' }), clock: { now: () => NOW } },
      due,
    );
    expect(r).toEqual({ ok: false, error: { kind: 'server_error', errClass: 'requester_not_found' } });
  });

  it('the erasure read fails → server_error with its class, never "held"', async () => {
    const r = await readDispatchHold(
      { tenant, sendStanding: makeFakeSendStanding({ erased: 'throws' }), clock: { now: () => NOW } },
      due,
    );
    expect(r).toEqual({ ok: false, error: { kind: 'server_error', errClass: 'Error' } });
  });
});

/**
 * Spec 139 P2 — the DELETE a dispatch leg makes before it refuses an erased
 * member's row. Cleared only on a confirmed delete (or a 403 on an id the probe
 * called `cancelled`, which can never be sent); anything else decides nothing.
 * Spec 140 s1 (ED4) — the same DELETE before a halted / ended refusal
 * (`refusal: 'standing'`); that caller records an undecided answer instead of
 * stalling on it.
 */
describe('deleteDraftBeforeRefusal (spec 139 P2, spec 140 s1 ED4)', () => {
  const ids = { tenantId: 'test-tenant', broadcastId: 'b-1', leg: 'live' as const, refusal: 'erased' as const };
  const gw = (answer: 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other' | 'throws') => ({
    deleteBroadcastOnce: vi.fn(async () => {
      if (answer === 'throws') throw new Error('gateway wiring fault');
      return { kind: answer };
    }),
  });

  it.each([
    ['no id on the row', null],
    ['an empty id (not an id)', { resendBroadcastId: '', probedStatus: null }],
  ] as const)('%s → cleared (none), no Resend call', async (_label, draft) => {
    const g = gw('deleted');
    expect(await deleteDraftBeforeRefusal(g, ids, draft)).toEqual({ kind: 'cleared', draftOutcome: 'none' });
    expect(g.deleteBroadcastOnce).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'absent'] as const)('DELETE answers %s → cleared', async (answer) => {
    const g = gw(answer);
    expect(await deleteDraftBeforeRefusal(g, ids, { resendBroadcastId: 'rb-1', probedStatus: 'draft' })).toEqual({
      kind: 'cleared',
      draftOutcome: answer,
    });
    expect(g.deleteBroadcastOnce).toHaveBeenCalledWith('rb-1');
  });

  it('403 on an id the probe called cancelled → cleared (a cancelled broadcast can never be sent)', async () => {
    expect(
      await deleteDraftBeforeRefusal(gw('forbidden'), ids, { resendBroadcastId: 'rb-1', probedStatus: 'cancelled' }),
    ).toEqual({ kind: 'cleared', draftOutcome: 'cancelled' });
  });

  it.each([
    ['403 on a draft (a restricted key)', 'forbidden', 'draft', 'forbidden'],
    ['403 on a not_found probe', 'forbidden', null, 'forbidden'],
    ['retryable (a timeout included)', 'retryable', 'draft', 'retryable'],
    ['other', 'other', 'draft', 'other'],
    ['a throw', 'throws', 'draft', 'threw'],
  ] as const)('%s → undecided', async (_label, answer, probedStatus, errClass) => {
    expect(await deleteDraftBeforeRefusal(gw(answer), ids, { resendBroadcastId: 'rb-1', probedStatus })).toEqual({
      kind: 'undecided',
      errClass,
    });
  });
});

/**
 * Spec 140 s1 review round 1 (reliability M-1, code-review #4, security L2) —
 * the halted / ended refusal's DELETE. A 403 on a draft the probe did not call
 * `cancelled` may be a sibling tick that has just sent it: ONE bounded GET
 * decides. Handed → `handed` (the leg answers a concurrent skip: no
 * `failed_to_dispatch`, no member email); anything else → `undeleted`, with a
 * closed `errClass` the leg records, and the refusal goes ahead.
 */
describe('deleteDraftBeforeStandingRefusal (spec 140 s1 ED4, review round 1)', () => {
  const ids = { tenantId: 'test-tenant', broadcastId: 'b-1', leg: 'import' as const };
  const gw = (
    answer: 'deleted' | 'absent' | 'forbidden' | 'retryable' | 'other',
    probe: 'queued' | 'sending' | 'sent' | 'draft' | 'cancelled' | 'unknown' | 'not_found' | 'retryable' | 'other' | 'throws' = 'draft',
  ) => ({
    deleteBroadcastOnce: vi.fn(async () => ({ kind: answer })),
    retrieveBroadcastOnce: vi.fn(async () => {
      if (probe === 'throws') throw new Error('a fake that breaks the never-throws contract');
      if (probe === 'not_found' || probe === 'retryable' || probe === 'other') return { kind: probe };
      return { kind: 'present' as const, status: probe };
    }),
  });
  const draft = { resendBroadcastId: 'rb-1', probedStatus: 'draft' as const };

  it.each(['queued', 'sending', 'sent'] as const)('403, then the GET says %s → handed (a sibling sent it): no refusal', async (status) => {
    const g = gw('forbidden', status);
    expect(await deleteDraftBeforeStandingRefusal(g, ids, draft)).toEqual({ kind: 'handed', resendStatus: status });
    expect(g.retrieveBroadcastOnce).toHaveBeenCalledTimes(1);
    expect(g.retrieveBroadcastOnce).toHaveBeenCalledWith('rb-1');
  });

  // Review round 2 (code-review #6) — the class says what the GET read, from a
  // closed set; a `cancelled` reading is an unsendable copy, so it clears.
  it.each([
    ['draft', 'probe_draft'],
    ['unknown', 'probe_other'],
    ['not_found', 'probe_not_found'],
    ['retryable', 'probe_retryable'],
    ['other', 'probe_other'],
    ['throws', 'threw'],
  ] as const)('403, then the GET says %s → undeleted (%s): the refusal goes ahead', async (probe, errClass) => {
    expect(await deleteDraftBeforeStandingRefusal(gw('forbidden', probe), ids, draft)).toEqual({ kind: 'undeleted', errClass });
  });

  it('403, then the GET says cancelled → cleared (cancelled): an unsendable copy, not an undeleted draft', async () => {
    expect(await deleteDraftBeforeStandingRefusal(gw('forbidden', 'cancelled'), ids, draft)).toEqual({ kind: 'cleared', draftOutcome: 'cancelled' });
  });

  it.each(['retryable', 'other'] as const)('%s → undeleted with that class, no GET', async (answer) => {
    const g = gw(answer);
    expect(await deleteDraftBeforeStandingRefusal(g, ids, draft)).toEqual({ kind: 'undeleted', errClass: answer });
    expect(g.retrieveBroadcastOnce).not.toHaveBeenCalled();
  });

  it('a 403 on an id the probe already called cancelled → cleared (cancelled), no GET', async () => {
    const g = gw('forbidden');
    expect(await deleteDraftBeforeStandingRefusal(g, ids, { resendBroadcastId: 'rb-1', probedStatus: 'cancelled' })).toEqual({
      kind: 'cleared',
      draftOutcome: 'cancelled',
    });
    expect(g.retrieveBroadcastOnce).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'absent'] as const)('%s → cleared, no GET', async (answer) => {
    const g = gw(answer);
    expect(await deleteDraftBeforeStandingRefusal(g, ids, draft)).toEqual({ kind: 'cleared', draftOutcome: answer });
    expect(g.retrieveBroadcastOnce).not.toHaveBeenCalled();
  });
});
