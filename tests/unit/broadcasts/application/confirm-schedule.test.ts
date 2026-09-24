/**
 * F119 T060 — `confirmSchedule`, the arms the route contract suites
 * (`admin-eblast-schedule`, `…-image-allowlist-recheck`,
 * `…-approval-not-voided`, `eblast-flag-matrix`) do not reach. 100 % branch
 * is pinned on this use case (T158).
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import {
  confirmSchedule,
  type ConfirmScheduleDeps,
  type ConfirmScheduleInput,
} from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakePortalRecipients,
  makeFakeSendStanding,
  makePortalContact,
  makeRecordingF7Audit,
  type FakeSendStandingOpts,
} from '../../../helpers/eblast-approval-fakes';

const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const APPROVED = makeApprovalVersion({ versionNo: 1, bodyHtml: '<img src="https://elsewhere.example/p.png" alt="p">', sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
const MEMBER = '22222222-2222-4222-8222-222222222222';

function setup(broadcast: Broadcast, standing: FakeSendStandingOpts = {}) {
  const store = makeFakeApprovalStore({ broadcasts: [broadcast], versions: [V0, APPROVED] });
  const sendStanding = makeFakeSendStanding(standing);
  const audit = makeRecordingF7Audit();
  const deps: ConfirmScheduleDeps = {
    tenant: asTenantContext('test-tenant'),
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    imageAllowlist: makeFakeImageAllowlist(['assets.swecham.zyncdata.app']),
    portalRecipients: makeFakePortalRecipients({ [MEMBER]: [makePortalContact()] }),
    outbox: store.outbox,
    audit,
    clock: { now: () => store.now },
    sendStanding,
  };
  const run = (patch: Partial<ConfirmScheduleInput> = {}) =>
    confirmSchedule(deps, {
      broadcastId: broadcast.broadcastId,
      actorUserId: '44444444-4444-4444-8444-444444444444',
      actorRole: null,
      requestId: null,
      mode: { mode: 'send_now' },
      ...patch,
    });
  return { store, audit, deps, run, sendStanding };
}

describe('confirmSchedule — the arms the route suites do not reach', () => {
  it('no recorded proposal → proposed_send_at null in the audit and differs true; no session role → actor_role null', async () => {
    const { audit, run } = setup(makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: APPROVED.id, proposedSendAt: null }));
    const r = await run();
    expect(r.ok && r.value).toMatchObject({ proposedSendAt: null, differs: true });
    expect(audit.events[0]!.payload).toMatchObject({ proposed_send_at: null, differs: true, actor_role: null, mode: 'send_now' });
  });

  it('an in-round row with no approved version → server_error (an invariant breach), nothing written', async () => {
    const { store, run } = setup(makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: null }));
    expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'Error' } });
    expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
  });

  it('a refused promotion with no request id is audited under the use case\'s own id', async () => {
    const { audit, run } = setup(makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: APPROVED.id }));
    const r = await run();
    expect(r.ok ? null : r.error.kind).toBe('image_source_not_allowlisted');
    expect(audit.emit).toHaveBeenCalledWith(null, expect.objectContaining({ requestId: 'confirm-schedule' }));
  });

  it.each([
    { mode: { mode: 'cancel' as const }, status: 'approved' as const, ids: { resendBroadcastId: 'rb-live-1' } },
    { mode: { mode: 'schedule' as const, scheduledFor: new Date('2026-10-05T03:00:00Z') }, status: 'approved' as const, ids: { resendBroadcastId: 'rb-live-1' } },
    { mode: { mode: 'send_now' as const }, status: 'approved' as const, ids: { audienceImportId: 'imp-live-1' } },
    { mode: { mode: 'send_now' as const }, status: 'member_approved' as const, ids: { resendBroadcastId: 'rb-inherited' } },
  ])('T166 R-H1: $mode.mode from $status once dispatch has begun → sending_started, nothing written', async ({ mode, status, ids }) => {
    const { store, audit, run } = setup(makeApprovalBroadcast({ status, currentRound: 1, approvedVersionId: APPROVED.id, ...ids }));
    expect(await run({ mode })).toEqual({ ok: false, error: { kind: 'sending_started', status } });
    expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    expect(store.outbox.rows()).toHaveLength(0);
    expect(audit.events).toHaveLength(0);
  });

  /**
   * T166 S-H1 — "the existing rules that block sending still apply at send
   * time" (spec § Edge Cases). Only submit read them; the 30-day round let a
   * member whose membership lapsed — or who was halted — have their E-Blast
   * promoted and sent. The promotion re-reads both, under the row lock.
   */
  describe('T166 S-H1 — the promotion re-checks the owning member\'s standing and the halt list', () => {
    const promotable = () => makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: V0.id });

    it.each([
      { standing: { halted: [MEMBER] }, kind: 'member_halted' },
      { standing: { access: 'terminated' as const }, kind: 'member_not_in_good_standing' },
      { standing: { access: 'suspended' as const }, kind: 'member_not_in_good_standing' },
    ])('$kind ($standing) → refused, nothing written, no member email', async ({ standing, kind }) => {
      const { store, audit, run, sendStanding } = setup(promotable(), standing);
      expect(await run()).toEqual({ ok: false, error: { kind } });
      expect(sendStanding.membershipAccess.getMembershipAccess.mock.calls.every((c) => c[1] === MEMBER)).toBe(true);
      expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
      expect(store.outbox.rows()).toHaveLength(0);
      expect(audit.events).toHaveLength(0);
    });

    it.each([
      { standing: { haltReadThrows: true }, errKind: 'Error' },
      { standing: { access: 'lookup_error' as const }, errKind: 'Error' },
    ])('a standing read that cannot be answered ($standing) fails CLOSED → server_error, nothing written', async ({ standing, errKind }) => {
      const { store, run } = setup(promotable(), standing);
      expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind } });
      expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    });

    it('a member in good standing is promoted (the gate is not over-eager)', async () => {
      const { run, sendStanding } = setup(promotable());
      const r = await run();
      expect(r.ok ? r.value.stage : r.error).toBe('approved');
      expect(sendStanding.membersBridge.getMembersHaltedInTenant).toHaveBeenCalledTimes(1);
    });

    it('a re-time of an already approved row does not re-read standing (the promotion is the send-time edge)', async () => {
      const { run, sendStanding } = setup(makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: APPROVED.id }), { halted: [MEMBER] });
      const r = await run({ mode: { mode: 'schedule', scheduledFor: new Date('2026-10-05T03:00:00Z') } });
      expect(r.ok ? r.value.stage : r.error).toBe('approved');
      expect(sendStanding.membersBridge.getMembersHaltedInTenant).not.toHaveBeenCalled();
    });
  });

  it('the allow-list read failing → server_error before any lock is taken', async () => {
    const { deps, store, run } = setup(makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: APPROVED.id }));
    vi.mocked(deps.imageAllowlist.findByTenantId).mockRejectedValueOnce(new TypeError('pool exhausted'));
    expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
    expect(store.broadcastsRepo.withTx).not.toHaveBeenCalled();
  });
});
