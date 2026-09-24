/**
 * F119 T039 (RED for T056) — `POST /api/admin/broadcasts/[id]/version`:
 * starting a formatted version leaves the member's original untouched and
 * both versions readable by marketing (US1-AS1, FR-001, FR-002).
 *
 * The route runs the REAL `startFormattedVersion` over the in-memory approval
 * store (see `tests/helpers/eblast-version-route-harness.ts`); only the gate,
 * the tenant resolver, the limiter and the composition root are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  getVersionRequest,
  harness,
  importVersionRoute,
  MARKETING_USER_ID,
  postVersionRequest,
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

const SUBMITTED = makeApprovalBroadcast();
const ID = SUBMITTED.broadcastId as string;

beforeEach(() => {
  resetVersionHarness({ broadcasts: [SUBMITTED] });
});

describe('POST /api/admin/broadcasts/[id]/version — start a formatted version', () => {
  it('after start, broadcasts.subject/body_html are unchanged and version_no = 0 holds the original', async () => {
    const { POST } = await importVersionRoute();
    const res = await POST(postVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(201);
    const body = await res.json();
    const row = harness.store.state.broadcasts.get(`test-tenant::${ID}`)!;
    // The sending record is untouched …
    expect(row.subject).toBe(SUBMITTED.subject);
    expect(row.bodyHtml).toBe(SUBMITTED.bodyHtml);
    expect(row.bodySource).toBe(SUBMITTED.bodySource);
    // … and moved to in_design with a fresh stage clock.
    expect(row.status).toBe('in_design');
    expect(row.stageEnteredAt).toEqual(harness.store.now);
    // v0 is the member's original, frozen (sent_to_member_at = the submit time).
    const [v0, v1] = harness.store.versionsRepo.rows();
    expect(v0).toMatchObject({
      versionNo: 0,
      subject: SUBMITTED.subject,
      bodyHtml: SUBMITTED.bodyHtml,
      bodySource: SUBMITTED.bodySource,
      authoredByUserId: SUBMITTED.submittedByUserId,
      authoredByRole: 'member_self_service',
      sentToMemberAt: SUBMITTED.submittedAt,
    });
    // v1 is marketing's working copy, seeded from v0.
    expect(v1).toMatchObject({
      versionNo: 1,
      subject: SUBMITTED.subject,
      bodyHtml: SUBMITTED.bodyHtml,
      authoredByUserId: MARKETING_USER_ID,
      authoredByRole: 'admin_proxy',
      sentToMemberAt: null,
      noteToMember: null,
    });
    expect(body).toEqual({
      stage: 'in_design',
      version: {
        id: v1!.id,
        versionNo: 1,
        subject: SUBMITTED.subject,
        bodyHtml: SUBMITTED.bodyHtml,
        bodySource: SUBMITTED.bodySource,
        noteToMember: null,
        updatedAt: harness.store.now.toISOString(),
      },
      memberOriginal: { id: v0!.id, versionNo: 0, subject: SUBMITTED.subject, bodyHtml: SUBMITTED.bodyHtml },
    });
  });

  it('marketing can read both versions afterwards (GET …/version)', async () => {
    const { POST, GET } = await importVersionRoute();
    await POST(postVersionRequest(ID), routeParams(ID));
    const res = await GET(getVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(200);
    const thread = await res.json();
    expect(thread.memberOriginal).toMatchObject({ versionNo: 0, subject: SUBMITTED.subject, bodyHtml: SUBMITTED.bodyHtml });
    expect(thread.workingCopy).toMatchObject({ versionNo: 1, sentToMemberAt: null });
    expect(thread.sentVersions).toEqual([]);
  });

  it('audits broadcast_version_started with related_member_id (never member_id), the round and the stage left — no content', async () => {
    const { POST } = await importVersionRoute();
    await POST(postVersionRequest(ID), routeParams(ID));

    const started = harness.audit.events.filter((e) => e.eventType === 'broadcast_version_started');
    expect(started).toHaveLength(1);
    expect(started[0]!.tx).toBe('fake-tx');
    expect(started[0]!.payload).toEqual({
      related_member_id: SUBMITTED.requestedByMemberId,
      broadcast_id: ID,
      version_id: harness.store.versionsRepo.rows()[1]!.id,
      round: 1,
      from_stage: 'submitted',
      actor_role: 'marketing',
    });
    expect(JSON.stringify(started[0]!.payload)).not.toContain(SUBMITTED.subject);
    expect(harness.audit.events.map((e) => e.eventType)).not.toContain('broadcast_member_approval_voided');
  });

  it('a second POST returns the existing working copy (201, idempotent) and writes nothing', async () => {
    const { POST } = await importVersionRoute();
    const first = await (await POST(postVersionRequest(ID), routeParams(ID))).json();
    const auditsBefore = harness.audit.events.length;

    const res = await POST(postVersionRequest(ID), routeParams(ID));
    expect(res.status).toBe(201);
    expect((await res.json()).version.id).toBe(first.version.id);
    expect(harness.store.versionsRepo.rows()).toHaveLength(2);
    expect(harness.audit.events).toHaveLength(auditsBefore);
  });

  it('re-entry from changes_requested seeds the next version from the latest one sent, reusing v0', async () => {
    const v0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, subject: 'orig', bodyHtml: '<p>orig</p>', sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
    const v1 = makeApprovalVersion({ versionNo: 1, subject: 'round one', bodyHtml: '<p>round one</p>', sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
    resetVersionHarness({
      broadcasts: [makeApprovalBroadcast({ status: 'changes_requested', currentRound: 1 })],
      versions: [v0, v1],
    });
    const { POST } = await importVersionRoute();
    const res = await POST(postVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(201);
    const rows = harness.store.versionsRepo.rows();
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ versionNo: 2, subject: 'round one', bodyHtml: '<p>round one</p>', sentToMemberAt: null });
    expect((await res.json()).memberOriginal.id).toBe(v0.id);
  });

  it('T166 R-H1: re-opening an approved row the dispatcher has already handed to Resend → 409 sending_started, nothing written', async () => {
    const v0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
    const v1 = makeApprovalVersion({ versionNo: 1, sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
    const approved = makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: v1.id, resendBroadcastId: 'rb-live-1' });
    resetVersionHarness({ broadcasts: [approved], versions: [v0, v1] });
    const { POST } = await importVersionRoute();
    const res = await POST(postVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('sending_started');
    expect(harness.store.versionsRepo.rows()).toHaveLength(2);
    expect(harness.store.state.broadcasts.get(`test-tenant::${ID}`)).toEqual(approved);
    expect(harness.audit.events).toHaveLength(0);
  });

  it('a stage that does not accept a start → 409 stage_changed and nothing is written', async () => {
    resetVersionHarness({ broadcasts: [makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1 })] });
    const { POST } = await importVersionRoute();
    const res = await POST(postVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('stage_changed');
    expect(harness.store.versionsRepo.rows()).toHaveLength(0);
    expect(harness.audit.events).toHaveLength(0);
  });

  it('an unknown or other-tenant id → 404 broadcast_not_found with the cross-tenant probe audited; a malformed id → 404 before any read', async () => {
    const { POST } = await importVersionRoute();
    const other = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const res = await POST(postVersionRequest(other), routeParams(other));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('broadcast_not_found');
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_cross_tenant_probe']);

    const bad = await POST(postVersionRequest('not-a-uuid'), routeParams('not-a-uuid'));
    expect(bad.status).toBe(404);
    expect(harness.store.broadcastsRepo.lockForUpdate).toHaveBeenCalledTimes(1);
  });
});
