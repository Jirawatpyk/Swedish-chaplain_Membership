/**
 * F119 T057 — what voids a member's approval, and what does not (FR-012,
 * spec § Edge Cases "Marketing edits after the member approved";
 * data-model § 8.3).
 *
 * Only a change to the CONTENT voids an approval, and the only place content
 * can change after the member approved is a new working copy — so opening one
 * (`POST …/[id]/version` from `member_approved` / `approved`) clears
 * `approved_version_id` + `scheduled_for` and audits
 * `broadcast_member_approval_voided`. The brand chrome and marketing's covering
 * note are not content and void nothing.
 *
 * Every arm runs the REAL use case over the same in-memory store, so
 * "`approved_version_id` is unchanged" is read off the row the next request
 * would see.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  harness,
  importScheduleRoute,
  importVersionRoute,
  patchVersionRequest,
  postScheduleRequest,
  postVersionRequest,
  resetVersionHarness,
  routeParams,
  staffCtx,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/rbac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/rbac')>('@/lib/rbac');
  const h = await import('../../helpers/eblast-version-route-harness');
  return { ...h.rbacMock(), canPerform: actual.canPerform };
});
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/modules/broadcasts', async () => {
  const h = await import('../../helpers/eblast-version-route-harness');
  const set = await import('@/modules/broadcasts/application/use-cases/set-brand-settings');
  const get = await import('@/modules/broadcasts/application/use-cases/get-brand-settings');
  return { ...(await h.broadcastsBarrelMock()), setBrandSettings: set.setBrandSettings, getBrandSettings: get.getBrandSettings };
});
vi.mock('@/lib/broadcast-brand-deps', async () => {
  const h = await import('../../helpers/eblast-version-route-harness');
  const f = await import('../../helpers/eblast-approval-fakes');
  return {
    makeBrandSettingsDeps: () => ({ repo: f.makeFakeBrandSettingsRepo(), audit: h.harness.audit, logoUrl: f.makeFakeTenantLogoUrlPort(null) }),
  };
});

const APPROVED_VERSION = makeApprovalVersion({ versionNo: 1, sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const SCHEDULED = new Date('2026-10-01T03:00:00.000Z');
const MEMBER_APPROVED = makeApprovalBroadcast({
  status: 'member_approved',
  currentRound: 1,
  approvedVersionId: APPROVED_VERSION.id,
  scheduledFor: SCHEDULED,
});
const ID = MEMBER_APPROVED.broadcastId as string;
const rowOf = () => harness.store.state.broadcasts.get(`test-tenant::${ID}`)!;

beforeEach(() => {
  resetVersionHarness({ broadcasts: [MEMBER_APPROVED], versions: [V0, APPROVED_VERSION] });
});

describe('what voids a member approval (FR-012)', () => {
  it('opening a new working copy clears it — approved_version_id and scheduled_for cleared, the void audited', async () => {
    const { POST } = await importVersionRoute();
    const res = await POST(postVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(201);
    expect(rowOf()).toMatchObject({ status: 'in_design', approvedVersionId: null, scheduledFor: null });
    const voided = harness.audit.events.find((e) => e.eventType === 'broadcast_member_approval_voided');
    expect(voided?.payload).toEqual({
      related_member_id: MEMBER_APPROVED.requestedByMemberId,
      broadcast_id: ID,
      voided_version_id: APPROVED_VERSION.id,
      round: 1,
      cancelled_schedule_at: SCHEDULED.toISOString(),
      actor_role: 'marketing',
    });
    // The new working copy is seeded from the version the member approved.
    expect(harness.store.versionsRepo.rows()[2]).toMatchObject({ versionNo: 2, subject: APPROVED_VERSION.subject, sentToMemberAt: null });
  });

  it('a brand PATCH leaves approved_version_id unchanged (brand chrome is not content)', async () => {
    harness.requireApiPermission.mockResolvedValue(staffCtx('admin', '55555555-5555-4555-8555-555555555555'));
    const { PATCH } = await import('@/app/api/admin/broadcasts/brand/route');
    const res = await PATCH(
      new NextRequest('http://localhost/api/admin/broadcasts/brand', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ primaryColor: '#0b5f3a', postalAddress: '1 Sukhumvit Rd' }),
      }),
    );

    expect(res.status).toBe(200);
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_brand_settings_changed']);
    expect(rowOf()).toEqual(MEMBER_APPROVED);
    expect(harness.store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
  });

  it('a note-only change leaves it — the save path never transitions the row', async () => {
    // `approved_version_id` is seeded non-null on an `in_design` row ONLY so a
    // write to it would be visible: the save path must not touch it.
    const working = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000002', versionNo: 2, updatedAt: new Date('2026-09-24T08:30:00Z') });
    resetVersionHarness({
      broadcasts: [{ ...MEMBER_APPROVED, status: 'in_design' }],
      versions: [V0, APPROVED_VERSION, working],
    });
    const { PATCH } = await importVersionRoute();
    const res = await PATCH(
      patchVersionRequest(ID, {
        subject: working.subject,
        bodyHtml: working.bodyHtml,
        bodySource: working.bodySource,
        noteToMember: 'Only the covering note changed.',
        expectedUpdatedAt: working.updatedAt.toISOString(),
      }),
      routeParams(ID),
    );

    expect(res.status).toBe(200);
    expect(harness.store.versionsRepo.rows()[2]!.noteToMember).toBe('Only the covering note changed.');
    expect(rowOf().approvedVersionId).toBe(APPROVED_VERSION.id);
    expect(harness.store.broadcastsRepo.applyTransition).not.toHaveBeenCalled();
    expect(harness.audit.events.map((e) => e.eventType)).not.toContain('broadcast_member_approval_voided');
  });

  it('a non-cancel schedule change leaves approved_version_id unchanged — confirming and re-timing are not content (FR-012)', async () => {
    const { POST } = await importScheduleRoute();
    const confirmed = new Date(harness.store.now.getTime() + 2 * 60 * 60 * 1000);
    const first = await POST(postScheduleRequest(ID, { mode: 'schedule', scheduledFor: confirmed.toISOString() }), routeParams(ID));
    expect(first.status).toBe(200);
    expect(rowOf()).toMatchObject({ status: 'approved', approvedVersionId: APPROVED_VERSION.id, scheduledFor: confirmed });

    // And re-timing the already-scheduled row: still the same approval.
    const second = await POST(postScheduleRequest(ID, { mode: 'send_now' }), routeParams(ID));
    expect(second.status).toBe(200);
    expect(rowOf().approvedVersionId).toBe(APPROVED_VERSION.id);
    expect(harness.audit.events.map((e) => e.eventType)).not.toContain('broadcast_member_approval_voided');
  });
});
