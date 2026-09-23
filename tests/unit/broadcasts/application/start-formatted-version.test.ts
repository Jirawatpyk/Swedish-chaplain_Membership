/**
 * F119 T056 / T057 — `startFormattedVersion`, the arms the route contract
 * suites (`admin-eblast-start-version`, `eblast-flag-matrix`,
 * `admin-eblast-approval-not-voided`) do not reach. Together they hold the
 * file at the 100 % branch pin (T158).
 *
 * Over the in-memory approval store, whose `withTx` restores its snapshot on
 * a throw — so "rolled back" is read off the store, not assumed.
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import {
  startFormattedVersion,
  type StartFormattedVersionDeps,
} from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalStore,
  makeRecordingF7Audit,
  type FakeApprovalStore,
} from '../../../helpers/eblast-approval-fakes';

const ACTOR = '44444444-4444-4444-8444-444444444444';
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const V1_SENT = makeApprovalVersion({ versionNo: 1, sentToMemberAt: new Date('2026-09-21T08:00:00Z') });

function setup(broadcast: Broadcast, versions = [V0, V1_SENT]) {
  const store = makeFakeApprovalStore({ broadcasts: [broadcast], versions });
  const audit = makeRecordingF7Audit();
  const deps: StartFormattedVersionDeps = {
    tenant: asTenantContext('test-tenant'),
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    audit,
    clock: { now: () => store.now },
    memberApprovalEnabled: true,
  };
  const run = (actorRole: string | null = 'marketing') =>
    startFormattedVersion(deps, { broadcastId: broadcast.broadcastId, actorUserId: ACTOR, actorRole, requestId: 'req-1' });
  return { store, audit, run };
}

const statusOf = (store: FakeApprovalStore, b: Broadcast) =>
  store.state.broadcasts.get(`test-tenant::${b.broadcastId}`)!.status;

describe('startFormattedVersion — arms the route suites do not reach', () => {
  it('a submitted row without a submit time freezes v0 at the start time', async () => {
    const b = makeApprovalBroadcast({ submittedAt: null });
    const { store, run } = setup(b, []);
    expect((await run()).ok).toBe(true);
    expect(store.versionsRepo.rows()[0]).toMatchObject({ versionNo: 0, sentToMemberAt: store.now });
  });

  it('voiding an approval with no send time booked records cancelled_schedule_at: null; a missing session role is recorded as null', async () => {
    const b = makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: V1_SENT.id, scheduledFor: null });
    const { audit, run } = setup(b);
    expect((await run(null)).ok).toBe(true);
    const voided = audit.events.find((e) => e.eventType === 'broadcast_member_approval_voided')!;
    expect(voided.payload).toMatchObject({ cancelled_schedule_at: null, actor_role: null });
    const started = audit.events.find((e) => e.eventType === 'broadcast_version_started')!;
    expect(started.payload).toMatchObject({ actor_role: null, from_stage: 'approved', round: 2 });
  });

  it('an unsent working copy already on file is reused, never duplicated (the one-unsent index)', async () => {
    const stray = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000002', versionNo: 2 });
    const b = makeApprovalBroadcast({ status: 'changes_requested', currentRound: 1 });
    const { store, run } = setup(b, [V0, V1_SENT, stray]);
    const r = await run();
    expect(r.ok && r.value.version.id).toBe(stray.id);
    expect(store.versionsRepo.insert).not.toHaveBeenCalled();
    expect(statusOf(store, b)).toBe('in_design');
  });

  it('an in_design row missing its working copy is an invariant breach → server_error, nothing written', async () => {
    const b = makeApprovalBroadcast({ status: 'in_design', currentRound: 1 });
    const { store, audit, run } = setup(b, [V0, V1_SENT]);
    const r = await run();
    expect(r).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'Error' } });
    expect(store.versionsRepo.insert).not.toHaveBeenCalled();
    expect(audit.events).toHaveLength(0);
  });

  it('a stage refusal is not a probe: `draft` → stage_changed with no audit row', async () => {
    const b = makeApprovalBroadcast({ status: 'draft', submittedAt: null });
    const { audit, run } = setup(b, []);
    expect(await run()).toEqual({ ok: false, error: { kind: 'stage_changed', status: 'draft' } });
    expect(audit.events).toHaveLength(0);
  });

  it('a fault after the first write rolls the whole start back (throw-to-rollback) → server_error', async () => {
    const b = makeApprovalBroadcast();
    const { store, audit, run } = setup(b, []);
    store.broadcastsRepo.applyTransition.mockRejectedValueOnce(new TypeError('connection reset'));
    const r = await run();
    expect(r).toEqual({ ok: false, error: { kind: 'server_error', errKind: 'TypeError' } });
    expect(store.versionsRepo.insert).toHaveBeenCalledTimes(2); // v0 + v1 were written …
    expect(store.versionsRepo.rows()).toHaveLength(0); // … and rolled back with the tx
    expect(statusOf(store, b)).toBe('submitted');
    expect(audit.events).toHaveLength(0);
  });
});
