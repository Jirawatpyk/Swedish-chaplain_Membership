/**
 * F119 T067 (owner) · T068 · T070 · T071 · T072 · T073 (staff-403 arm) · T074 ·
 * T077 · T081a · T150 (decided arm) — `POST /api/broadcasts/[id]/decision` and
 * the member-write bucket on the widened `POST /api/broadcasts/[id]/cancel`
 * (contracts/portal-eblast-approval-api.md; spec US2, FR-009, FR-010, FR-013,
 * FR-015, FR-015a, FR-033, FR-034).
 *
 * The routes run the REAL `recordMemberDecision` / `cancelBroadcast` over the
 * in-memory approval store (whose `withTx` is a real rollback boundary, and
 * whose outbox rows live in the store). Stubbed: the rate limiter
 * (`harness.checkLimit`), the tenant, and the member session — except that a
 * STAFF session is handed to the REAL `requireMemberContext`, so FR-013's
 * "a staff user can never give the member-side approval" is asserted against
 * the production gate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err } from '@/lib/result';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  HARNESS_MEMBER_ID,
  OTHER_MEMBER_ID,
  PORTAL_CONTACT_ID,
  PORTAL_USER_ID,
  SECOND_MARKETER,
  harness,
  importDecisionRoute,
  importMemberCancelRoute,
  postDecisionRequest,
  postMemberCancelRequest,
  resetVersionHarness,
  routeParams,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/auth-session', async () => (await import('../../helpers/eblast-version-route-harness')).authSessionMock());
vi.mock('@/lib/member-context', async () => (await import('../../helpers/eblast-version-route-harness')).memberContextMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/lib/broadcast-marketing-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).marketingDepsMock(),
);
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);
// T074 — the two reads the REAL `requireMemberContext` makes once
// `harness.member.realGate` is set: the member behind the session, and the
// member's latest renewal cycle (LAPSED, grace long expired → `terminated`).
// The gate itself — `checkPortalAccess` and its route policy — runs for real.
const gateAudit = vi.hoisted(() => ({ events: [] as Array<{ type: string; payload: Record<string, unknown> }> }));
vi.mock('@/modules/members/members-deps', async () => {
  const { ok } = await import('@/lib/result');
  const { harness: h } = await import('../../helpers/eblast-version-route-harness');
  return {
    buildMembersDeps: () => ({
      memberRepo: { findByLinkedUserId: async () => ok({ memberId: h.member.memberId }) },
      contactRepo: {
        listByMember: async () =>
          ok([{ contactId: h.member.contactId, memberId: h.member.memberId, linkedUserId: h.member.userId }]),
      },
    }),
  };
});
vi.mock('@/lib/portal-access-deps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/portal-access-deps')>('@/lib/portal-access-deps');
  const { buildCycle } = await import('../../unit/renewals/_helpers/build-cycle');
  const { HARNESS_MEMBER_ID: memberId } = await import('../../helpers/eblast-version-route-harness');
  const lapsed = buildCycle({ tenantId: 'test-tenant', memberId, status: 'lapsed', expiresAt: '2026-01-01T00:00:00Z' });
  return {
    ...actual,
    buildPortalAccessDeps: () => ({
      cyclesRepo: { findLatestCycleForMember: async () => lapsed },
      auditEmitter: {
        emit: async (event: { type: string; payload: Record<string, unknown> }) => {
          gateAudit.events.push(event);
        },
      },
      clock: { now: () => new Date('2026-09-24T03:00:00.000Z') },
    }),
  };
});

const ROOT = join(__dirname, '..', '..', '..');
const ID = makeApprovalBroadcast().broadcastId as string;
const KEY = `test-tenant::${ID}`;
const SENT_AT = new Date('2026-09-21T08:00:00.000Z');
const CONFIRMED = new Date('2026-10-02T05:30:00.000Z');
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const V1 = makeApprovalVersion({ versionNo: 1, sentToMemberAt: SENT_AT });
const V2 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000002', versionNo: 2, sentToMemberAt: new Date('2026-09-23T08:00:00Z') });
const REASON = 'SECRET-REASON-7c1e the date in the heading is wrong';

const awaiting = (overrides: Partial<Broadcast> = {}) =>
  makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1, stageEnteredAt: SENT_AT, memberReminderStage: 1, ...overrides });
const row = () => harness.store.state.broadcasts.get(KEY)!;
const decide = async (body: unknown) => {
  const { POST } = await importDecisionRoute();
  return POST(postDecisionRequest(ID, body), routeParams(ID));
};

beforeEach(() => {
  resetVersionHarness({ broadcasts: [awaiting()], versions: [V0, V1] });
});

describe('approve — awaiting_member_approval → member_approved (US1-AS4, FR-009)', () => {
  it('200 with the new stage and whose turn it is, the approved version recorded, and one hand-off row PER marketing recipient', async () => {
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ stage: 'member_approved', whoseTurn: 'marketing', round: 1, decision: { versionId: V1.id, decision: 'approved' } });

    expect(row()).toMatchObject({ status: 'member_approved', approvedVersionId: V1.id, stageEnteredAt: harness.store.now });
    expect(harness.store.decisionsRepo.rows()).toEqual([
      expect.objectContaining({ versionId: V1.id, round: 1, decision: 'approved', reason: null, decidedByUserId: PORTAL_USER_ID, decidedByContactId: PORTAL_CONTACT_ID }),
    ]);

    const outbox = harness.store.outbox.rows();
    expect(outbox.map((r) => r.toEmail)).toEqual(['marketing@swecham.test', SECOND_MARKETER.email]);
    for (const [i, r] of outbox.entries()) {
      expect(r.type).toBe('eblast_member_decided_marketing');
      expect(r.contextData).toEqual({
        tenantId: 'test-tenant',
        broadcastId: ID,
        versionId: V1.id,
        round: 1,
        decision: 'approved',
        recipientUserId: harness.marketingRoster[i]!.userId,
      });
    }
  });

  it('audits broadcast_member_approved with snake_case member_id (member activity — the 0009 trigger key), note_length, the session role, and never the note', async () => {
    await decide({ versionId: V1.id, decision: 'approved', reason: 'Looks great, thanks!' });
    const event = harness.audit.events.find((e) => e.eventType === 'broadcast_member_approved')!;
    expect(event.payload).toEqual({
      member_id: HARNESS_MEMBER_ID,
      broadcast_id: ID,
      version_id: V1.id,
      round: 1,
      note_length: 'Looks great, thanks!'.length,
      actor_role: 'member',
    });
    expect(event.actorUserId).toBe(PORTAL_USER_ID);
    expect(JSON.stringify(harness.audit.events)).not.toContain('Looks great');
  });

  it('T068: a 500-character approval note is accepted, a 501-character one → 422 validation_error with nothing written', async () => {
    expect((await decide({ versionId: V1.id, decision: 'approved', reason: 'n'.repeat(500) })).status).toBe(200);

    resetVersionHarness({ broadcasts: [awaiting()], versions: [V0, V1] });
    const res = await decide({ versionId: V1.id, decision: 'approved', reason: 'n'.repeat(501) });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.fieldErrors).toEqual({ reason: ['too_long'] });
    expect(row().status).toBe('awaiting_member_approval');
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
  });

  it('a blank approval note is no note (stored NULL, never an empty string the CHECK would refuse)', async () => {
    expect((await decide({ versionId: V1.id, decision: 'approved', reason: '   ' })).status).toBe(200);
    expect(harness.store.decisionsRepo.rows()[0]!.reason).toBeNull();
  });
});

describe('request changes — awaiting_member_approval → changes_requested (US2-AS1/AS2, FR-010)', () => {
  it('T067: blank reason on changes_requested → 422 reason_required, announced on the reason field, nothing written', async () => {
    for (const reason of [undefined, '', '   ']) {
      const res = await decide({ versionId: V1.id, decision: 'changes_requested', ...(reason === undefined ? {} : { reason }) });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error.code).toBe('reason_required');
      expect(body.error.fieldErrors).toEqual({ reason: ['reason_required'] });
    }
    expect(row().status).toBe('awaiting_member_approval');
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
    expect(harness.store.outbox.rows()).toHaveLength(0);
  });

  it('T068: a 2,001-character reason → 422 validation_error; 2,000 is accepted', async () => {
    const tooLong = await decide({ versionId: V1.id, decision: 'changes_requested', reason: 'r'.repeat(2001) });
    expect(tooLong.status).toBe(422);
    expect((await tooLong.json()).error.code).toBe('validation_error');
    expect((await decide({ versionId: V1.id, decision: 'changes_requested', reason: 'r'.repeat(2000) })).status).toBe(200);
  });

  it('200: back to marketing, the reminder clock reset, the reason on the decision row, reason_length (never the text) on the audit row', async () => {
    const res = await decide({ versionId: V1.id, decision: 'changes_requested', reason: REASON });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: 'changes_requested', whoseTurn: 'marketing', round: 1 });
    expect(row()).toMatchObject({ status: 'changes_requested', memberReminderStage: 0, stageEnteredAt: harness.store.now });
    expect(harness.store.decisionsRepo.rows()[0]).toMatchObject({ decision: 'changes_requested', reason: REASON, round: 1 });

    const event = harness.audit.events.find((e) => e.eventType === 'broadcast_member_changes_requested')!;
    expect(event.payload).toEqual({
      member_id: HARNESS_MEMBER_ID,
      broadcast_id: ID,
      version_id: V1.id,
      round: 1,
      reason_length: REASON.length,
      actor_role: 'member',
    });
    expect(JSON.stringify(harness.audit.events)).not.toContain('SECRET-REASON');
    expect(JSON.stringify(harness.store.outbox.rows())).not.toContain('SECRET-REASON');
    expect(harness.store.outbox.rows().map((r) => r.contextData.decision)).toEqual(['changes_requested', 'changes_requested']);
  });
});

describe('withdraw an approval (US2-AS6, FR-015, FR-015a)', () => {
  const approved = () =>
    makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: V1.id, scheduledFor: CONFIRMED, subject: V1.subject, bodyHtml: V1.bodyHtml });

  it('T070: approval_withdrawn from approved → changes_requested, scheduled_for NULL, approved_version_id NULL, cancelled_schedule_at in the audit payload', async () => {
    resetVersionHarness({ broadcasts: [approved()], versions: [V0, V1] });
    const res = await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stage: 'changes_requested', whoseTurn: 'marketing', round: 1 });
    expect(row()).toMatchObject({ status: 'changes_requested', scheduledFor: null, approvedVersionId: null, stageEnteredAt: harness.store.now });
    // A withdrawn approval does not start a round (FR-026).
    expect(row().currentRound).toBe(1);

    const event = harness.audit.events.find((e) => e.eventType === 'broadcast_member_approval_withdrawn')!;
    expect(event.payload).toEqual({
      member_id: HARNESS_MEMBER_ID,
      broadcast_id: ID,
      version_id: V1.id,
      round: 1,
      reason_length: REASON.length,
      cancelled_schedule_at: CONFIRMED.toISOString(),
      actor_role: 'member',
    });
    expect(harness.store.outbox.rows().map((r) => r.contextData.decision)).toEqual(['approval_withdrawn', 'approval_withdrawn']);
  });

  it('T071: withdraw while approved/Scheduled → 200, and from member_approved → 200', async () => {
    resetVersionHarness({ broadcasts: [approved()], versions: [V0, V1] });
    expect((await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON })).status).toBe(200);

    resetVersionHarness({ broadcasts: [makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: V1.id })], versions: [V0, V1] });
    expect((await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON })).status).toBe(200);
    expect(row()).toMatchObject({ status: 'changes_requested', approvedVersionId: null });
  });

  it('T071: withdraw while sending → 409 sending_started (checked BEFORE the stage rule, which sending also fails) — the send completes', async () => {
    resetVersionHarness({ broadcasts: [approved()], versions: [V0, V1] });
    harness.store.state.broadcasts.set(KEY, { ...row(), status: 'sending' });
    const res = await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('sending_started');
    expect(row().status).toBe('sending');
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
  });

  it.each([
    { leg: 'a Resend broadcast id is on the row (legacy leg)', ids: { resendBroadcastId: 'rb-live-1' } },
    { leg: 'an audience import is on the row (import leg)', ids: { audienceImportId: 'imp-live-1' } },
  ])('T166 R-H1: withdraw from approved once dispatch has begun — $leg → 409 sending_started, nothing written', async ({ ids }) => {
    resetVersionHarness({ broadcasts: [{ ...approved(), ...ids }], versions: [V0, V1] });
    const res = await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('sending_started');
    expect(row()).toMatchObject({ status: 'approved', approvedVersionId: V1.id, scheduledFor: CONFIRMED });
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
    expect(harness.store.outbox.rows()).toHaveLength(0);
  });

  it('no reason on approval_withdrawn → 422 reason_required', async () => {
    resetVersionHarness({ broadcasts: [approved()], versions: [V0, V1] });
    const res = await decide({ versionId: V1.id, decision: 'approval_withdrawn' });
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe('reason_required');
  });
});

describe('races and stale views (FR-033, spec § Edge Cases "act at the same moment")', () => {
  it('T072: an older versionId → 409 stale_version carrying the current version, nothing written', async () => {
    resetVersionHarness({ broadcasts: [awaiting({ currentRound: 2 })], versions: [V0, V1, V2] });
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('stale_version');
    expect(body.error.details.currentVersion).toEqual({ id: V2.id, versionNo: 2 });
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
    expect(row().status).toBe('awaiting_member_approval');
  });

  it('T072: approve twice → the second is 409 stage_changed carrying the decision already recorded (research R19 — not a replay)', async () => {
    expect((await decide({ versionId: V1.id, decision: 'approved' })).status).toBe(200);
    const recorded = harness.store.decisionsRepo.rows()[0]!;
    const again = await decide({ versionId: V1.id, decision: 'approved' });
    expect(again.status).toBe(409);
    const body = await again.json();
    expect(body.error.code).toBe('stage_changed');
    expect(body.error.details).toMatchObject({ status: 'member_approved', recordedDecision: { id: recorded.id, decision: 'approved', versionId: V1.id } });
    expect(harness.store.decisionsRepo.rows()).toHaveLength(1);
    expect(harness.store.outbox.rows()).toHaveLength(2);
  });

  it('approve while changes_requested → 409 stage_changed', async () => {
    resetVersionHarness({ broadcasts: [awaiting({ status: 'changes_requested' })], versions: [V0, V1] });
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('stage_changed');
  });
});

describe('the remaining refusal arms', () => {
  it('withdraw an approval that was never given (still awaiting the member) → 409 stage_changed', async () => {
    const res = await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON });
    expect(res.status).toBe(409);
    expect((await res.json()).error.details).toMatchObject({ status: 'awaiting_member_approval', recordedDecision: null });
  });

  it('withdraw on an approve-as-submitted E-Blast (approved, round 0 — the member never approved anything) → 409 stage_changed', async () => {
    resetVersionHarness({ broadcasts: [makeApprovalBroadcast({ status: 'approved', currentRound: 0 })], versions: [] });
    const res = await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('stage_changed');
  });

  it('withdraw from member_approved with no send time set → cancelled_schedule_at null', async () => {
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: V1.id, scheduledFor: null })],
      versions: [V0, V1],
    });
    expect((await decide({ versionId: V1.id, decision: 'approval_withdrawn', reason: REASON })).status).toBe(200);
    const event = harness.audit.events.find((e) => e.eventType === 'broadcast_member_approval_withdrawn')!;
    expect((event.payload as { cancelled_schedule_at: string | null }).cancelled_schedule_at).toBeNull();
  });

  it('awaiting the member but no version was ever sent (an inconsistent row) → 409 stale_version with no current version, nothing written', async () => {
    resetVersionHarness({ broadcasts: [awaiting()], versions: [V0] });
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('stale_version');
    expect(body.error.details.currentVersion).toBeNull();
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
  });

  it('an infrastructure fault → 500 internal_error, nothing written', async () => {
    harness.store.failNextCommit();
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(500);
    expect(row().status).toBe('awaiting_member_approval');
    expect(harness.store.outbox.rows()).toHaveLength(0);
  });
});

describe('owning member and session (FR-013, spec § Tenant scope)', () => {
  it('T073: a staff session → 403 on POST …/decision, refused by the REAL requireMemberContext — nothing read, nothing written', async () => {
    for (const role of ['admin', 'marketing', 'manager', 'super_admin'] as const) {
      harness.member = { ...harness.member, role };
      const res = await decide({ versionId: V1.id, decision: 'approved' });
      expect(res.status).toBe(403);
    }
    expect(harness.store.broadcastsRepo.findByIdInTx).not.toHaveBeenCalled();
    expect(harness.checkLimit).not.toHaveBeenCalled();
    expect(row().status).toBe('awaiting_member_approval');
  });

  it("another member of the same tenant → 404 + broadcast_cross_member_probe (camelCase keys — a refused probe must not move the probed member's recency)", async () => {
    harness.member = { ...harness.member, memberId: OTHER_MEMBER_ID };
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(404);
    const probe = harness.audit.events.find((e) => e.eventType === 'broadcast_cross_member_probe')!;
    expect(probe.payload).toEqual({ probedMemberId: OTHER_MEMBER_ID, probedBroadcastId: ID, operation: 'member_decision' });
    expect(JSON.stringify(probe.payload)).not.toContain('member_id');
    expect(row().status).toBe('awaiting_member_approval');
  });

  it('an unknown (or other-tenant) id → 404 + broadcast_cross_tenant_probe; a malformed id → 404 with no audit row', async () => {
    resetVersionHarness({ broadcasts: [], versions: [] });
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(404);
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);

    resetVersionHarness({ broadcasts: [awaiting()], versions: [V0, V1] });
    const { POST } = await importDecisionRoute();
    const malformed = await POST(postDecisionRequest('not-a-uuid', { versionId: V1.id, decision: 'approved' }), routeParams('not-a-uuid'));
    expect(malformed.status).toBe(404);
    expect(harness.audit.events).toHaveLength(0);
  });

  it('T074: a lapsed member may still decide — deciding is not a benefit action, so neither the route nor the use case consults membership standing', async () => {
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(200);
    const sources = [
      'src/app/api/broadcasts/[id]/decision/route.ts',
      'src/modules/broadcasts/application/use-cases/approval/record-member-decision.ts',
    ].map((p) => readFileSync(join(ROOT, p), 'utf8'));
    for (const source of sources) {
      expect(source).not.toMatch(/membershipAccess|MembershipAccessPort|checkPortalAccess|deriveMembershipAccess|isHalted|haltedUntil/);
    }
  });

  it("T074 (real gate): a LAPSED member's decision passes the REAL requireMemberContext → 200, while that member's submit and inline-image upload stay refused", async () => {
    const { requireMemberContext } = await import('@/lib/member-context');
    gateAudit.events.length = 0;
    harness.member = { ...harness.member, realGate: true };

    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(200);
    expect(row().status).toBe('member_approved');
    expect(gateAudit.events).toHaveLength(0);

    const { POST: cancel } = await importMemberCancelRoute();
    resetVersionHarness({ broadcasts: [awaiting()], versions: [V0, V1] });
    harness.member = { ...harness.member, realGate: true };
    expect((await cancel(postMemberCancelRequest(ID), routeParams(ID))).status).toBe(200);

    // Positive control: the same gate, the same lapsed member, a benefit-consuming route.
    for (const path of ['/api/broadcasts/submit', '/api/broadcasts/inline-image-upload', `/api/broadcasts/draft/${ID}`]) {
      const refused = await requireMemberContext(new NextRequest(`http://localhost${path}`, { method: 'POST' }));
      expect(refused.response?.status, path).toBe(403);
      expect((await refused.response!.json()).error.code).toBe('membership_access_restricted');
    }
    expect(gateAudit.events.map((e) => e.payload.blocked_route)).toEqual([
      '/api/broadcasts/submit',
      '/api/broadcasts/inline-image-upload',
      `/api/broadcasts/draft/${ID}`,
    ]);
  });

  it('a body that is not JSON, or names an unknown decision → 400 invalid_body before the use case', async () => {
    const { POST } = await importDecisionRoute();
    expect((await POST(postDecisionRequest(ID, '{not json'), routeParams(ID))).status).toBe(400);
    expect((await decide({ versionId: V1.id, decision: 'withdrawn' })).status).toBe(400);
    expect((await decide({ versionId: 'v1', decision: 'approved' })).status).toBe(400);
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
  });
});

describe('T150 — the flag gates the submitted → in_design edge, not this route (FR-034)', () => {
  it.each([true, false])('flagOn=%s: a broadcast already in awaiting_member_approval can still be approved', async (flagOn) => {
    harness.flagOn = flagOn;
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(200);
    expect(row().status).toBe('member_approved');
  });

  it('a broadcast in submitted answers 409 stage_changed in both flag states', async () => {
    for (const flagOn of [true, false]) {
      resetVersionHarness({ broadcasts: [makeApprovalBroadcast()], versions: [] });
      harness.flagOn = flagOn;
      const res = await decide({ versionId: V1.id, decision: 'approved' });
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('stage_changed');
    }
  });
});

describe('the member write bucket — 60 / minute per (tenant, user), atomic, consumed first (T077, T081a)', () => {
  it('T077: the 61st decision in a minute → 429 broadcast_rate_limit_exceeded with Retry-After — no decision row, stage unchanged', async () => {
    harness.checkLimit.mockResolvedValue(err({ retryAfterSeconds: 42 }));
    const res = await decide({ versionId: V1.id, decision: 'approved' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_rate_limit_exceeded');
    expect(body.error.details).toEqual({ retryAfterSeconds: 42 });
    expect(harness.checkLimit).toHaveBeenCalledWith(`broadcasts:member-write:test-tenant:${PORTAL_USER_ID}`, 60, 60);
    expect(harness.store.broadcastsRepo.withTx).not.toHaveBeenCalled();
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
    expect(row().status).toBe('awaiting_member_approval');
  });

  it('under the bucket, the bucket is consumed BEFORE the decision transaction opens', async () => {
    await decide({ versionId: V1.id, decision: 'approved' });
    expect(harness.checkLimit.mock.invocationCallOrder[0]!).toBeLessThan(harness.store.broadcastsRepo.withTx.mock.invocationCallOrder[0]!);
  });

  it('T081a: the 61st …/cancel in a minute → 429 with Retry-After; the refused call leaves the stage unchanged and writes no decision row', async () => {
    harness.checkLimit.mockResolvedValue(err({ retryAfterSeconds: 9 }));
    const { POST } = await importMemberCancelRoute();
    const res = await POST(postMemberCancelRequest(ID, { cancellationReason: 'No longer needed' }), routeParams(ID));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('9');
    expect((await res.json()).error.code).toBe('broadcast_rate_limit_exceeded');
    expect(harness.checkLimit).toHaveBeenCalledWith(`broadcasts:member-write:test-tenant:${PORTAL_USER_ID}`, 60, 60);
    expect(harness.store.broadcastsRepo.withTx).not.toHaveBeenCalled();
    expect(row().status).toBe('awaiting_member_approval');
    expect(harness.store.decisionsRepo.rows()).toHaveLength(0);
  });

  it('T081 (member half): under the bucket, withdrawing from awaiting_member_approval is accepted — and the chamber is told', async () => {
    const { POST } = await importMemberCancelRoute();
    const res = await POST(postMemberCancelRequest(ID, { cancellationReason: 'No longer needed' }), routeParams(ID));
    expect(res.status).toBe(200);
    expect(row().status).toBe('cancelled');
    const outbox = harness.store.outbox.rows();
    expect(outbox).toHaveLength(2);
    expect(outbox.every((r) => r.type === 'eblast_member_decided_marketing' && r.contextData.decision === 'withdrawn')).toBe(true);
  });
});
