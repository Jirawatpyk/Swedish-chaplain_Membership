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
 *     halt list nor F8 access is read;
 *   - the erasure read throws → `erasure_read_failed` (fail CLOSED);
 *   - a live member → the halt rule, then F8 access, as before.
 *
 * The send-time decision (`decideDispatchStanding`) maps `erased` to its own
 * permanent refusal, `refuse_erased`, which carries no standing-refusal audit
 * row (P3: the member-visible "membership suspended" event must never label an
 * erasure) and the existing `member_not_in_good_standing` failure token; a
 * failed erasure read is `undecided`.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { readMemberSendStanding } from '@/modules/broadcasts/application/use-cases/_member-send-standing';
import {
  decideDispatchStanding,
  deleteErasedDraftBeforeRefusal,
} from '@/modules/broadcasts/application/use-cases/_dispatch-standing-gate';
import { readDispatchHold } from '@/modules/broadcasts/application/use-cases/read-dispatch-hold';
import { makeFakeSendStanding } from '../../../helpers/eblast-approval-fakes';

const tenant = asTenantContext('test-tenant');

describe('readMemberSendStanding — erasure is read first (spec 139 DE1)', () => {
  it.each([
    ['erased', true],
    ['not found in the tenant (P4)', 'not_found'],
  ] as const)('a member %s → erased; the halt list and F8 access are never read', async (_label, erased) => {
    // Halted AND terminated too: erasure must win over both.
    const deps = makeFakeSendStanding({ erased, halted: ['m-1'], access: 'terminated' });
    expect(await readMemberSendStanding(deps, tenant, 'm-1')).toEqual({ kind: 'erased' });
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
  it.each([
    ['erased', true],
    ['not found (P4)', 'not_found'],
  ] as const)('%s → refuse_erased (member_not_in_good_standing), no standing-refusal audit row to write', async (_label, erased) => {
    expect(await decideDispatchStanding(makeFakeSendStanding({ erased }), tenant, 'm-1')).toEqual({
      kind: 'refuse_erased',
      reason: 'member_not_in_good_standing',
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
 */
describe('deleteErasedDraftBeforeRefusal (spec 139 P2)', () => {
  const ids = { tenantId: 'test-tenant', broadcastId: 'b-1', leg: 'live' as const };
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
    expect(await deleteErasedDraftBeforeRefusal(g, ids, draft)).toEqual({ kind: 'cleared', draftOutcome: 'none' });
    expect(g.deleteBroadcastOnce).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'absent'] as const)('DELETE answers %s → cleared', async (answer) => {
    const g = gw(answer);
    expect(await deleteErasedDraftBeforeRefusal(g, ids, { resendBroadcastId: 'rb-1', probedStatus: 'draft' })).toEqual({
      kind: 'cleared',
      draftOutcome: answer,
    });
    expect(g.deleteBroadcastOnce).toHaveBeenCalledWith('rb-1');
  });

  it('403 on an id the probe called cancelled → cleared (a cancelled broadcast can never be sent)', async () => {
    expect(
      await deleteErasedDraftBeforeRefusal(gw('forbidden'), ids, { resendBroadcastId: 'rb-1', probedStatus: 'cancelled' }),
    ).toEqual({ kind: 'cleared', draftOutcome: 'cancelled' });
  });

  it.each([
    ['403 on a draft (a restricted key)', 'forbidden', 'draft', 'forbidden'],
    ['403 on a not_found probe', 'forbidden', null, 'forbidden'],
    ['retryable (a timeout included)', 'retryable', 'draft', 'retryable'],
    ['other', 'other', 'draft', 'other'],
    ['a throw', 'throws', 'draft', 'threw'],
  ] as const)('%s → undecided', async (_label, answer, probedStatus, errClass) => {
    expect(await deleteErasedDraftBeforeRefusal(gw(answer), ids, { resendBroadcastId: 'rb-1', probedStatus })).toEqual({
      kind: 'undecided',
      message: 'member_erased_draft_not_deleted',
      errClass,
    });
  });
});
