/**
 * F119 T061 — `GET /api/admin/broadcasts/[id]/version`, the staff side of
 * the history record (FR-002, FR-011, FR-032): the member's original, every
 * version sent to the member with who wrote it and when, every member
 * decision with its reason, the working copy with its concurrency token.
 * `broadcasts.read`, so a manager reads the whole thread.
 *
 * The REAL `listBroadcastVersions` over the in-memory store; staff names come
 * through the fake `ActorNameDirectoryPort`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import type { MemberDecision } from '@/modules/broadcasts/domain/approval/member-decision';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  getVersionRequest,
  harness,
  importVersionRoute,
  MARKETING_USER_ID,
  resetVersionHarness,
  routeParams,
  staffCtx,
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

const B = makeApprovalBroadcast({ status: 'in_design', currentRound: 1 });
const ID = B.broadcastId as string;
const V0 = makeApprovalVersion({
  id: 'aaaaaaaa-0000-4000-8000-000000000000',
  versionNo: 0,
  subject: 'Member original',
  authoredByUserId: B.submittedByUserId,
  authoredByRole: 'member_self_service',
  sentToMemberAt: new Date('2026-09-20T08:00:00.000Z'),
});
const V1 = makeApprovalVersion({ versionNo: 1, noteToMember: 'Shortened the intro.', sentToMemberAt: new Date('2026-09-21T08:00:00.000Z') });
const V2 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000002', versionNo: 2, updatedAt: new Date('2026-09-23T10:00:00.000Z') });
const CHANGES: MemberDecision = {
  id: 'dddddddd-0000-4000-8000-000000000001',
  tenantId: 'test-tenant',
  broadcastId: asBroadcastId(ID),
  versionId: V1.id,
  round: 1,
  decision: 'changes_requested',
  reason: 'Please use our new logo colour in the heading.',
  decidedByUserId: '88888888-8888-4888-8888-888888888888',
  decidedByContactId: '99999999-9999-4999-8999-999999999999',
  decidedAt: new Date('2026-09-22T08:00:00.000Z'),
};

beforeEach(() => {
  resetVersionHarness({ broadcasts: [B], versions: [V2, V0, V1], decisions: [CHANGES] });
  harness.names = { [MARKETING_USER_ID]: 'Maja Marketing' };
});

describe('GET /api/admin/broadcasts/[id]/version — the version thread', () => {
  it('a manager gets the full thread: original, sent versions with author and time, decisions with reasons, the working copy', async () => {
    harness.requireApiPermission.mockResolvedValue(staffCtx('manager', '66666666-6666-4666-8666-666666666666'));
    const { GET } = await importVersionRoute();
    const res = await GET(getVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(200);
    expect(harness.requireApiPermission.mock.calls[0]![1]).toBe('broadcasts.read');
    expect(await res.json()).toEqual({
      broadcastId: ID,
      status: 'in_design',
      stage: 'in_design',
      round: 1,
      approvedVersionId: null,
      memberOriginal: expect.objectContaining({
        id: V0.id,
        versionNo: 0,
        subject: 'Member original',
        authoredByUserId: B.submittedByUserId,
        authoredByName: null,
        sentToMemberAt: '2026-09-20T08:00:00.000Z',
      }),
      sentVersions: [
        {
          id: V1.id,
          versionNo: 1,
          subject: V1.subject,
          bodyHtml: V1.bodyHtml,
          bodySource: V1.bodySource,
          noteToMember: 'Shortened the intro.',
          authoredByUserId: MARKETING_USER_ID,
          authoredByName: 'Maja Marketing',
          sentToMemberAt: '2026-09-21T08:00:00.000Z',
          createdAt: V1.createdAt.toISOString(),
          updatedAt: V1.updatedAt.toISOString(),
        },
      ],
      workingCopy: expect.objectContaining({ id: V2.id, versionNo: 2, sentToMemberAt: null, updatedAt: '2026-09-23T10:00:00.000Z' }),
      decisions: [
        {
          id: CHANGES.id,
          versionId: V1.id,
          round: 1,
          decision: 'changes_requested',
          reason: 'Please use our new logo colour in the heading.',
          decidedByUserId: CHANGES.decidedByUserId,
          decidedAt: '2026-09-22T08:00:00.000Z',
        },
      ],
      approvedAsSubmitted: null,
    });
  });

  it('the thread is its own record: the audit trail is not read and nothing is written', async () => {
    const { GET } = await importVersionRoute();
    await GET(getVersionRequest(ID), routeParams(ID));
    expect(harness.audit.events).toHaveLength(0);
    expect(harness.store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    expect(harness.checkLimit).not.toHaveBeenCalled(); // reads are not bucketed
  });

  it('another tenant\'s id → 404 broadcast_not_found with the probe audited', async () => {
    const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const { GET } = await importVersionRoute();
    const res = await GET(getVersionRequest(other), routeParams(other));
    expect(res.status).toBe(404);
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);
  });
});
