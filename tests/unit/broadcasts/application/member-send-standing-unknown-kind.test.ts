/**
 * F119 round-4 B2 — the three `MemberSendStanding` switches fail CLOSED on a
 * kind they do not know.
 *
 * `submitBroadcast`, `approveBroadcast` (approve-as-submitted) and
 * `confirmSchedule`'s promotion each switch on the standing read. Without a
 * `default` arm, a kind that slips past the compiler (a widened union, a
 * mock, a cast) fell out of the switch and the code went on to SEND — the
 * gate answered "in good standing" for a result it never understood. Each
 * switch now throws on it (`assertNever`), so the row is not made
 * dispatchable. The unknown kind is forced here through the one reader all
 * three share — and, since F119 PR-A, the dispatch tick, whose switch answers
 * a transient `dispatch.server_error` instead (nothing is sent). Spec 140 s4
 * deleted the legacy leg and its row of the table below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const standing = vi.hoisted(() => ({ value: { kind: 'bogus' } as unknown }));
vi.mock('@/modules/broadcasts/application/use-cases/_member-send-standing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/broadcasts/application/use-cases/_member-send-standing')>()),
  readMemberSendStanding: vi.fn(async () => standing.value),
}));

import { asTenantContext } from '@/modules/tenants';
import { approveBroadcast } from '@/modules/broadcasts/application/use-cases/approve-broadcast';
import { submitBroadcast } from '@/modules/broadcasts/application/use-cases/submit-broadcast';
import { confirmSchedule } from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import { buildAudienceTick } from '@/modules/broadcasts/application/use-cases/build-audience-tick';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakePortalRecipients,
  makeFakeSendStanding,
  makeRecordingF7Audit,
} from '../../../helpers/eblast-approval-fakes';
import { makeTickAuditDouble, type TickHarnessDeps } from '../../../support/broadcasts/tick-deps-type';

const tenant = asTenantContext('test-tenant');
const ACTOR = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  standing.value = { kind: 'bogus' };
});

describe('an unknown MemberSendStanding kind is never read as "may send"', () => {
  it('submitBroadcast throws before any write', async () => {
    const deps = { tenant } as never;
    await expect(
      submitBroadcast(deps, { memberId: 'm-1', submittedByUserId: 'u-1', actorRole: 'member_self_service' } as never),
    ).rejects.toThrow(/assertNever/);
  });

  it('approveBroadcast → approve.server_error, no transition', async () => {
    const row = makeApprovalBroadcast({ status: 'submitted' });
    const store = makeFakeApprovalStore({ broadcasts: [row] });
    const r = await approveBroadcast(
      {
        tenant,
        broadcastsRepo: store.broadcastsRepo as never,
        sendStanding: makeFakeSendStanding(),
        audit: makeRecordingF7Audit(),
        clock: { now: () => store.now },
      },
      { broadcastId: row.broadcastId, actorUserId: ACTOR, actorRole: 'marketing', decision: { mode: 'send_now' }, requestId: null },
    );
    expect(r).toEqual({ ok: false, error: { kind: 'approve.server_error', errKind: 'Error' } });
    expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
  });

  it('confirmSchedule\'s promotion → server_error, nothing promoted', async () => {
    const v1 = makeApprovalVersion({ versionNo: 1, sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
    const row = makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: v1.id });
    const store = makeFakeApprovalStore({ broadcasts: [row], versions: [v1] });
    const r = await confirmSchedule(
      {
        tenant,
        broadcastsRepo: store.broadcastsRepo,
        versionsRepo: store.versionsRepo,
        imageAllowlist: makeFakeImageAllowlist(),
        portalRecipients: makeFakePortalRecipients({}),
        outbox: store.outbox,
        audit: makeRecordingF7Audit(),
        clock: { now: () => store.now },
        sendStanding: makeFakeSendStanding(),
      },
      { broadcastId: row.broadcastId, actorUserId: ACTOR, actorRole: 'marketing', requestId: null, mode: { mode: 'send_now' } },
    );
    expect(r).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'Error' } });
    expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
  });

  /**
   * F119 PR-A — the SEND-time switch. An unknown kind did not decide the gate,
   * so nothing is sent: the same transient answer a failed read gets (the row
   * stays `approved`), and Resend is never called.
   */
  it('buildAudienceTick → dispatch.server_error (phase standing), nothing sent, nothing written', async () => {
    const row = makeApprovalBroadcast({ status: 'approved' });
    const store = makeFakeApprovalStore({ broadcasts: [row] });
    const gatewayCalls: string[] = [];
    const gateway = new Proxy(
      {},
      { get: (_t, prop) => (prop === 'then' ? undefined : async () => void gatewayCalls.push(String(prop))) },
    );
    const audit = makeTickAuditDouble();
    // The shared tick harness type: every port key present, the audit double whole.
    // The ports the standing phase never reaches are empty stubs.
    const deps: TickHarnessDeps = {
      tenant,
      // Spec 140 s2b — the dispatch lease: the tick claims (always granted
      // here) and releases.
      broadcastsRepo: {
        ...store.broadcastsRepo,
        claimDispatchLease: async () => 'lease-token-test',
        checkDispatchLease: async () => 'held' as const,
        releaseDispatchLease: async () => true,
      },
      broadcastsGateway: gateway,
      sendStanding: makeFakeSendStanding(),
      clock: { now: () => store.now },
      tickBudget: { tickStartedAt: store.now.getTime() },
      audit,
      brandChrome: {},
      fromEmail: 'noreply@example.test',
      tenantDisplayName: 'Example',
      locale: 'en',
      resolveRecipients: {},
      membersBridge: {},
      emailTransactional: {},
      plansBridge: {},
      orphans: {},
    };
    const r = await buildAudienceTick(deps as never, { broadcastId: row.broadcastId });
    expect(r).toEqual({
      ok: false,
      error: { kind: 'dispatch.server_error', message: 'member_standing_unrouted', errClass: 'gate', phase: 'standing' },
    });
    expect(store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    expect(gatewayCalls).toEqual([]);
    expect([...audit.emitted, ...audit.emittedOnce]).toEqual([]);
  });
});
