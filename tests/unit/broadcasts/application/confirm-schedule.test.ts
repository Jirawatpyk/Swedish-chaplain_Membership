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
  makePortalContact,
  makeRecordingF7Audit,
} from '../../../helpers/eblast-approval-fakes';

const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const APPROVED = makeApprovalVersion({ versionNo: 1, bodyHtml: '<img src="https://elsewhere.example/p.png" alt="p">', sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
const MEMBER = '22222222-2222-4222-8222-222222222222';

function setup(broadcast: Broadcast) {
  const store = makeFakeApprovalStore({ broadcasts: [broadcast], versions: [V0, APPROVED] });
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
  return { store, audit, deps, run };
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

  it('the allow-list read failing → server_error before any lock is taken', async () => {
    const { deps, store, run } = setup(makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: APPROVED.id }));
    vi.mocked(deps.imageAllowlist.findByTenantId).mockRejectedValueOnce(new TypeError('pool exhausted'));
    expect(await run()).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
    expect(store.broadcastsRepo.withTx).not.toHaveBeenCalled();
  });
});
