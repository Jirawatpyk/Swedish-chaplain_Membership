/**
 * F119 T042 · T060 — `POST /api/admin/broadcasts/[id]/schedule` (US1-AS5,
 * FR-012, FR-012a, FR-016, FR-017, FR-018; contracts
 * admin-eblast-formatting-api.md § schedule).
 *
 *   member_approved + keep_proposal | schedule | send_now
 *       → PROMOTES the approved version onto the sending record (trigger
 *         exemption E1 — the only post-submit content write), sets the time,
 *         → approved;
 *   approved + schedule | send_now → changes the time only;
 *   approved + cancel → clears the time, → changes_requested (off the only
 *         dispatchable status).
 *
 * The member's proposal is the frozen `proposed_send_at` and is never
 * overwritten; the confirmed time is `scheduled_for`. The existing now + 5 min
 * floor applies (`approve-broadcast.ts`). The REAL `confirmSchedule` runs
 * through the route over the in-memory approval store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApprovalBroadcast, makeApprovalVersion, FAKE_TX } from '../../helpers/eblast-approval-fakes';
import {
  HARNESS_MEMBER_ID,
  harness,
  importScheduleRoute,
  postScheduleRequest,
  resetVersionHarness,
  routeParams,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);

const NOW = new Date('2026-09-24T09:00:00.000Z'); // the store clock
const PROPOSED = new Date('2026-10-01T03:00:00.000Z');
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const APPROVED_VERSION = makeApprovalVersion({
  versionNo: 1,
  subject: 'The version the member approved',
  bodyHtml: '<p>Approved body — byte for byte</p>',
  bodySource: '{"approved":true}',
  sentToMemberAt: new Date('2026-09-21T08:00:00Z'),
});
const MEMBER_APPROVED = makeApprovalBroadcast({
  status: 'member_approved',
  currentRound: 1,
  approvedVersionId: APPROVED_VERSION.id,
  proposedSendAt: PROPOSED,
  scheduledFor: PROPOSED,
  stageEnteredAt: new Date('2026-09-23T10:00:00Z'),
});
const SCHEDULED_ALREADY = makeApprovalBroadcast({
  ...MEMBER_APPROVED,
  status: 'approved',
  subject: APPROVED_VERSION.subject,
  bodyHtml: APPROVED_VERSION.bodyHtml,
  bodySource: APPROVED_VERSION.bodySource,
});
const ID = MEMBER_APPROVED.broadcastId as string;
const rowOf = () => harness.store.state.broadcasts.get(`test-tenant::${ID}`)!;
const inMinutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

async function schedule(body: unknown, id = ID) {
  const { POST } = await importScheduleRoute();
  return POST(postScheduleRequest(id, body), routeParams(id));
}

beforeEach(() => {
  resetVersionHarness({ broadcasts: [MEMBER_APPROVED], versions: [V0, APPROVED_VERSION] });
});

describe('T042 — the proposal, the floor and the difference (FR-016/017/018)', () => {
  it('keep_proposal with a past proposal → 422 broadcast_schedule_too_soon, nothing changes', async () => {
    resetVersionHarness({
      broadcasts: [{ ...MEMBER_APPROVED, proposedSendAt: inMinutes(-60), scheduledFor: inMinutes(-60) }],
      versions: [V0, APPROVED_VERSION],
    });
    const res = await schedule({ mode: 'keep_proposal' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('broadcast_schedule_too_soon');
    expect(rowOf().status).toBe('member_approved');
    expect(harness.store.outbox.rows()).toHaveLength(0);
  });

  it('keep_proposal inside the 5-minute floor is refused the same way', async () => {
    resetVersionHarness({ broadcasts: [{ ...MEMBER_APPROVED, proposedSendAt: inMinutes(4) }], versions: [V0, APPROVED_VERSION] });
    expect((await schedule({ mode: 'keep_proposal' })).status).toBe(422);
  });

  it('keep_proposal with no proposal → 409 no_proposal', async () => {
    resetVersionHarness({ broadcasts: [{ ...MEMBER_APPROVED, proposedSendAt: null }], versions: [V0, APPROVED_VERSION] });
    const res = await schedule({ mode: 'keep_proposal' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('no_proposal');
    expect(rowOf().status).toBe('member_approved');
  });

  it('the audit row carries differs: true when the confirmed time is not the proposal; the proposal itself is untouched', async () => {
    const confirmed = inMinutes(120);
    const res = await schedule({ mode: 'schedule', scheduledFor: confirmed.toISOString() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stage: 'approved',
      confirmedSendAt: confirmed.toISOString(),
      proposedSendAt: PROPOSED.toISOString(),
      differs: true,
    });
    const audit = harness.audit.events.filter((e) => e.eventType === 'broadcast_schedule_confirmed');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.tx).toBe(FAKE_TX);
    expect(audit[0]!.payload).toEqual({
      related_member_id: HARNESS_MEMBER_ID,
      broadcast_id: ID,
      version_id: APPROVED_VERSION.id,
      proposed_send_at: PROPOSED.toISOString(),
      confirmed_send_at: confirmed.toISOString(),
      differs: true,
      mode: 'schedule',
      actor_role: 'marketing',
    });
    expect(rowOf()).toMatchObject({ scheduledFor: confirmed, proposedSendAt: PROPOSED });
  });

  it('keep_proposal on a future proposal confirms exactly that instant: differs false', async () => {
    const res = await schedule({ mode: 'keep_proposal' });
    expect(res.status).toBe(200);
    expect((await res.json()).differs).toBe(false);
    expect(rowOf().scheduledFor).toEqual(PROPOSED);
  });

  it('an explicit time inside the floor → 422 broadcast_schedule_too_soon before any read', async () => {
    const res = await schedule({ mode: 'schedule', scheduledFor: inMinutes(4).toISOString() });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('broadcast_schedule_too_soon');
    expect(harness.store.broadcastsRepo.withTx).not.toHaveBeenCalled();
  });
});

describe('T060 — the promotion (FR-012a E1): member_approved → approved', () => {
  it('send_now copies the approved version onto the sending record byte-for-byte, stamps the approval and the clock, and tells the member', async () => {
    const res = await schedule({ mode: 'send_now' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stage: 'approved',
      confirmedSendAt: NOW.toISOString(),
      proposedSendAt: PROPOSED.toISOString(),
      differs: true,
    });
    expect(rowOf()).toMatchObject({
      status: 'approved',
      subject: APPROVED_VERSION.subject,
      bodyHtml: APPROVED_VERSION.bodyHtml,
      bodySource: APPROVED_VERSION.bodySource,
      scheduledFor: NOW,
      approvedAt: NOW,
      approvedByUserId: '44444444-4444-4444-8444-444444444444',
      approvedVersionId: APPROVED_VERSION.id,
      stageEnteredAt: NOW,
      proposedSendAt: PROPOSED,
    });
    expect(harness.store.outbox.rows()).toEqual([
      {
        tx: FAKE_TX,
        tenantId: 'test-tenant',
        type: 'eblast_schedule_confirmed_member',
        toEmail: 'owner@acme.test',
        locale: 'th',
        contextData: { tenantId: 'test-tenant', broadcastId: ID, versionId: APPROVED_VERSION.id },
      },
    ]);
  });

  it('a member_approved row whose approved version cannot be found → 500, nothing promoted (an invariant breach, not a refusal)', async () => {
    resetVersionHarness({ broadcasts: [MEMBER_APPROVED], versions: [V0] });
    const res = await schedule({ mode: 'send_now' });
    expect(res.status).toBe(500);
    expect(rowOf()).toEqual(MEMBER_APPROVED);
  });
});

describe('T060 — from approved: change the time, or cancel it', () => {
  beforeEach(() => {
    resetVersionHarness({ broadcasts: [SCHEDULED_ALREADY], versions: [V0, APPROVED_VERSION] });
  });

  it('schedule changes scheduled_for only — no promotion, the stage clock does not restart', async () => {
    const later = inMinutes(600);
    const res = await schedule({ mode: 'schedule', scheduledFor: later.toISOString() });
    expect(res.status).toBe(200);
    expect(rowOf()).toMatchObject({ status: 'approved', scheduledFor: later, stageEnteredAt: SCHEDULED_ALREADY.stageEnteredAt });
    expect(harness.store.broadcastsRepo.applyTransition.mock.calls[0]![4]).toEqual({ scheduledFor: later });
    expect(harness.store.outbox.rows().map((r) => r.type)).toEqual(['eblast_schedule_confirmed_member']);
  });

  it('cancel clears the time AND the approved version in one write, moving the row to changes_requested — off the dispatchable status', async () => {
    const res = await schedule({ mode: 'cancel' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      stage: 'changes_requested',
      confirmedSendAt: null,
      proposedSendAt: PROPOSED.toISOString(),
      differs: false,
    });
    // `approved_version_id` is the SC-002 proof column: once the row leaves
    // member_approved / approved it names no approval that governs the row —
    // marketing must send a new version and the member approve it again.
    expect(rowOf()).toMatchObject({
      status: 'changes_requested',
      scheduledFor: null,
      approvedVersionId: null,
      stageEnteredAt: NOW,
    });
    expect(harness.store.broadcastsRepo.applyTransition).toHaveBeenCalledTimes(1);
    expect(harness.store.broadcastsRepo.applyTransition.mock.calls[0]![4]).toEqual({ scheduledFor: null, approvedVersionId: null });
    // The cancel audit still names the approval it cancelled; it is NOT a void.
    expect(harness.audit.events.find((e) => e.eventType === 'broadcast_schedule_confirmed')?.payload).toMatchObject({
      version_id: APPROVED_VERSION.id,
      mode: 'cancel',
      confirmed_send_at: null,
      differs: false,
    });
    expect(harness.audit.events.map((e) => e.eventType)).not.toContain('broadcast_member_approval_voided');
    // No confirmed time to tell the member about.
    expect(harness.store.outbox.rows()).toHaveLength(0);
  });

  it('keep_proposal from approved → 409 mode_not_allowed; cancel from member_approved → 409 mode_not_allowed', async () => {
    const keep = await schedule({ mode: 'keep_proposal' });
    expect(keep.status).toBe(409);
    expect((await keep.json()).error.code).toBe('mode_not_allowed');

    resetVersionHarness({ broadcasts: [MEMBER_APPROVED], versions: [V0, APPROVED_VERSION] });
    const cancel = await schedule({ mode: 'cancel' });
    expect(cancel.status).toBe(409);
    expect((await cancel.json()).error.code).toBe('mode_not_allowed');
    expect(rowOf()).toEqual(MEMBER_APPROVED);
  });

  it('an approve-as-submitted row (round 0) was never in a design round → 409 round_zero on every mode', async () => {
    const roundZero = makeApprovalBroadcast({ status: 'approved', currentRound: 0, approvedVersionId: null });
    for (const body of [{ mode: 'cancel' }, { mode: 'send_now' }, { mode: 'schedule', scheduledFor: inMinutes(60).toISOString() }]) {
      resetVersionHarness({ broadcasts: [roundZero] });
      const res = await schedule(body);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('round_zero');
      expect(rowOf()).toEqual(roundZero);
    }
  });
});

describe('the stage, the id and the body', () => {
  it('any other stage → 409 stage_changed', async () => {
    resetVersionHarness({ broadcasts: [makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1 })] });
    const res = await schedule({ mode: 'send_now' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('stage_changed');
  });

  it('an unknown / other-tenant id → 404 with the probe audited', async () => {
    const res = await schedule({ mode: 'send_now' }, '99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(404);
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);
  });

  it('a malformed body or an unknown mode → 400 invalid_body before the bucket is consumed', async () => {
    for (const body of ['{not json', { mode: 'now' }, { mode: 'schedule' }, { mode: 'schedule', scheduledFor: 'tomorrow' }]) {
      const res = await schedule(body);
      expect(res.status).toBe(400);
    }
    expect(harness.checkLimit).not.toHaveBeenCalled();
  });

  it('no active portal contact left → the time is still confirmed and no outbox row is written (a notification never blocks the send)', async () => {
    harness.portalContacts = {};
    const res = await schedule({ mode: 'send_now' });
    expect(res.status).toBe(200);
    expect(rowOf().status).toBe('approved');
    expect(harness.store.outbox.rows()).toHaveLength(0);
  });
});
