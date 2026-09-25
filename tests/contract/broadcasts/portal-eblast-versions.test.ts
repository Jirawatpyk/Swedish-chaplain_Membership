/**
 * F119 T087 (T086's contract arm) — `GET /api/broadcasts/[id]/versions`
 * (contracts/portal-eblast-approval-api.md § versions; FR-008, FR-032,
 * FR-007, FR-013).
 *
 * The route runs the REAL `getMemberVersionThread` over the in-memory
 * approval store. Stubbed: the tenant and the member session — except that a
 * STAFF session is handed to the REAL `requireMemberContext`, so the member-
 * only gate is asserted against production code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import type { MemberDecision } from '@/modules/broadcasts/domain/approval/member-decision';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  HARNESS_MEMBER_ID,
  OTHER_MEMBER_ID,
  PORTAL_CONTACT_ID,
  PORTAL_USER_ID,
  getMemberVersionsRequest,
  harness,
  importMemberVersionsRoute,
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
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);

const ID = makeApprovalBroadcast().broadcastId as string;
const STAFF_USER_ID = '44444444-4444-4444-8444-444444444444';
const COLLEAGUE_USER_ID = '99999999-9999-4999-8999-999999999999';
const SUBMITTED_AT = new Date('2026-09-20T08:00:00.000Z');
const V1_SENT = new Date('2026-09-21T08:00:00.000Z');
const V0 = makeApprovalVersion({
  id: 'aaaaaaaa-0000-4000-8000-000000000000',
  versionNo: 0,
  authoredByRole: 'member_self_service',
  authoredByUserId: PORTAL_USER_ID,
  subject: 'Member original subject',
  sentToMemberAt: SUBMITTED_AT,
  createdAt: SUBMITTED_AT,
});
const V1 = makeApprovalVersion({ versionNo: 1, noteToMember: 'Moved the date up top.', sentToMemberAt: V1_SENT, createdAt: V1_SENT });
const WORKING_COPY = makeApprovalVersion({
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  versionNo: 2,
  subject: 'WORK-IN-PROGRESS-9f2c marketing draft',
  bodyHtml: '<p>WORK-IN-PROGRESS-9f2c</p>',
  noteToMember: 'WORK-IN-PROGRESS-9f2c note',
  sentToMemberAt: null,
});
const decision = (overrides: Partial<MemberDecision> = {}): MemberDecision => ({
  id: 'cccccccc-0000-4000-8000-000000000001',
  tenantId: 'test-tenant',
  broadcastId: makeApprovalBroadcast().broadcastId,
  versionId: V1.id,
  round: 1,
  decision: 'changes_requested',
  reason: 'The date is wrong.',
  decidedByUserId: PORTAL_USER_ID,
  decidedByContactId: PORTAL_CONTACT_ID,
  decidedAt: new Date('2026-09-22T08:00:00.000Z'),
  ...overrides,
});

const inDesign = (overrides: Partial<Broadcast> = {}) =>
  makeApprovalBroadcast({ status: 'in_design', currentRound: 1, stageEnteredAt: new Date('2026-09-23T08:00:00.000Z'), ...overrides });

const get = async (id = ID) => {
  const { GET } = await importMemberVersionsRoute();
  return GET(getMemberVersionsRequest(id), routeParams(id));
};

beforeEach(() => {
  resetVersionHarness({ broadcasts: [inDesign()], versions: [V0, V1, WORKING_COPY], decisions: [decision()] });
});

describe('GET /api/broadcasts/[id]/versions — the member’s history (FR-032)', () => {
  it('an unsent version is absent', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([0, 1]);
    // Not a byte of marketing's work in progress leaves the server.
    expect(JSON.stringify(body)).not.toContain('WORK-IN-PROGRESS-9f2c');
  });

  it('carries the versions shown and the decisions, oldest first, with the author as member / organisation and never a staff user', async () => {
    const body = await (await get()).json();
    expect(body.versions).toEqual([
      {
        id: V0.id,
        versionNo: 0,
        authoredBy: 'member',
        subject: 'Member original subject',
        bodyHtml: V0.bodyHtml,
        noteToMember: null,
        // the member wrote v0; nobody sent it to them
        sentToMemberAt: null,
        createdAt: SUBMITTED_AT.toISOString(),
      },
      {
        id: V1.id,
        versionNo: 1,
        authoredBy: 'organisation',
        subject: V1.subject,
        bodyHtml: V1.bodyHtml,
        noteToMember: 'Moved the date up top.',
        sentToMemberAt: V1_SENT.toISOString(),
        createdAt: V1_SENT.toISOString(),
      },
    ]);
    expect(body.decisions).toEqual([
      {
        id: 'cccccccc-0000-4000-8000-000000000001',
        versionId: V1.id,
        round: 1,
        decision: 'changes_requested',
        reason: 'The date is wrong.',
        decidedAt: '2026-09-22T08:00:00.000Z',
        decidedByMe: true,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(STAFF_USER_ID);
    expect(body.approvedAsSubmitted).toBeNull();
  });

  it('a decision recorded by a colleague of the same company is not "by me"', async () => {
    resetVersionHarness({
      broadcasts: [inDesign()],
      versions: [V0, V1],
      decisions: [decision({ decidedByUserId: COLLEAGUE_USER_ID })],
    });
    const body = await (await get()).json();
    expect(body.decisions[0].decidedByMe).toBe(false);
    expect(JSON.stringify(body)).not.toContain(COLLEAGUE_USER_ID);
  });

  it('while awaiting the member: whose turn is the member\'s and the approval expires 30 days after the stage was entered', async () => {
    const sentAt = new Date('2026-09-21T08:00:00.000Z');
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1, stageEnteredAt: sentAt })],
      versions: [V0, V1],
    });
    const body = await (await get()).json();
    expect(body.broadcast).toEqual({
      id: ID,
      stage: 'awaiting_member_approval',
      whoseTurn: 'member',
      round: 1,
      proposedSendAt: '2026-10-01T03:00:00.000Z',
      // `scheduled_for` still holds the member's submit-time request — not a confirmation
      confirmedSendAt: null,
      approvedVersionId: null,
      stageEnteredAt: sentAt.toISOString(),
      expiresAt: '2026-10-21T08:00:00.000Z',
    });
  });

  it('an approve-as-submitted E-Blast returns empty versions and decisions and a populated approvedAsSubmitted (FR-007)', async () => {
    const approvedAt = new Date('2026-09-22T09:00:00.000Z');
    resetVersionHarness({
      broadcasts: [
        makeApprovalBroadcast({
          status: 'approved',
          approvedAt,
          approvedByUserId: STAFF_USER_ID,
          scheduledFor: new Date('2026-10-01T03:00:00.000Z'),
        }),
      ],
    });
    const body = await (await get()).json();
    expect(body.versions).toEqual([]);
    expect(body.decisions).toEqual([]);
    expect(body.approvedAsSubmitted).toEqual({ at: approvedAt.toISOString(), by: 'organisation' });
    expect(body.broadcast).toMatchObject({ stage: 'scheduled', whoseTurn: null, confirmedSendAt: '2026-10-01T03:00:00.000Z', expiresAt: null });
    expect(JSON.stringify(body)).not.toContain(STAFF_USER_ID);
  });
});

describe('GET /api/broadcasts/[id]/versions — the owning-member rule (FR-013)', () => {
  it('another member\'s E-Blast → 404, audited broadcast_cross_member_probe, nothing of theirs in the body', async () => {
    resetVersionHarness({
      broadcasts: [inDesign({ requestedByMemberId: OTHER_MEMBER_ID })],
      versions: [V0, V1],
      decisions: [decision()],
    });
    const res = await get();
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Member original subject');
    const probes = harness.audit.events.filter((e) => e.eventType === 'broadcast_cross_member_probe');
    expect(probes).toHaveLength(1);
    expect(probes[0]!.payload).toEqual({ probedMemberId: HARNESS_MEMBER_ID, probedBroadcastId: ID, operation: 'version_thread' });
    // A refused probe never spells the 0009 trigger key.
    expect(Object.keys(probes[0]!.payload as object)).not.toContain('member_id');
    // The other member's children were never read.
    expect(harness.store.versionsRepo.listByBroadcast).not.toHaveBeenCalled();
  });

  it('an unknown (or another tenant\'s) id → 404, audited broadcast_cross_tenant_probe', async () => {
    const res = await get('99999999-9999-4999-8999-999999999999');
    expect(res.status).toBe(404);
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);
  });

  it('a read fault → 500 internal_error, and no probe is audited', async () => {
    harness.store.broadcastsRepo.findByIdInTx.mockRejectedValueOnce(new Error('connection reset'));
    const res = await get();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'internal_error' } });
    expect(harness.audit.events).toEqual([]);
  });

  it('a malformed id → 404 with no audit row and no read', async () => {
    const res = await get('not-a-uuid');
    expect(res.status).toBe(404);
    expect(harness.audit.events).toEqual([]);
    expect(harness.store.broadcastsRepo.findByIdInTx).not.toHaveBeenCalled();
  });

  it.each(['marketing', 'admin', 'manager'] as const)('a %s (staff) session → 403 from the real member gate', async (role) => {
    harness.member = { ...harness.member, role };
    const res = await get();
    expect(res.status).toBe(403);
    expect(harness.store.broadcastsRepo.findByIdInTx).not.toHaveBeenCalled();
  });
});
