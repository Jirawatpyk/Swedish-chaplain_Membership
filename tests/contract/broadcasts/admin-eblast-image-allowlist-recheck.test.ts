/**
 * F119 T044 — an image whose host left the tenant allow-list after the
 * version was saved blocks BOTH the send to the member and the promotion,
 * naming which image and why, and leaves the version editable (spec § Edge
 * Cases "An image's source host is removed from the allow-list while a
 * version is pending"; contracts admin-eblast-formatting-api.md § send,
 * § schedule).
 *
 * The allow-list is re-read at the moment of the send / the promotion; the
 * version was saved while the host WAS allowed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  harness,
  importScheduleRoute,
  importSendRoute,
  importVersionRoute,
  patchVersionRequest,
  postScheduleRequest,
  postSendRequest,
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

const HOST = 'assets.swecham.zyncdata.app';
const SRC = `https://${HOST}/broadcasts/images/test-tenant/banner.png`;
const OK_SRC = 'https://cdn.resend.dev/logo.png';
const BODY = `<p>Hello</p><img src="${SRC}" alt="Spring gala banner"><img src="${OK_SRC}" alt="Logo">`;
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const ID = makeApprovalBroadcast().broadcastId as string;
const rowOf = () => harness.store.state.broadcasts.get(`test-tenant::${ID}`)!;
/** The host was removed from the tenant allow-list after the save; the CDN host stays. */
const hostRemoved = () => {
  harness.allowlistHosts = ['cdn.resend.dev'];
};
const REFUSED_IMAGES = [{ src: SRC, host: HOST, reason: 'not_allowlisted' }];

describe('send → 422 image_source_not_allowlisted naming the image; the version stays editable', () => {
  const WORKING = makeApprovalVersion({ versionNo: 1, bodyHtml: BODY, updatedAt: new Date('2026-09-24T08:30:00Z') });
  beforeEach(() => {
    resetVersionHarness({ broadcasts: [makeApprovalBroadcast({ status: 'in_design' })], versions: [V0, WORKING] });
    harness.allowlistHosts = [HOST, 'cdn.resend.dev'];
  });

  it('with the host still allowed the same version is sendable (the positive control)', async () => {
    const { POST } = await importSendRoute();
    expect((await POST(postSendRequest(ID), routeParams(ID))).status).toBe(200);
  });

  it('host removed → 422 with { images: [{ src, host, reason }] }, nothing sent; the refusal is audited without the body; a replaced image then saves', async () => {
    hostRemoved();
    const { POST } = await importSendRoute();
    const res = await POST(postSendRequest(ID), routeParams(ID));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('image_source_not_allowlisted');
    expect(body.error.details).toEqual({ images: REFUSED_IMAGES });
    expect(rowOf().status).toBe('in_design');
    expect(harness.store.versionsRepo.rows()[1]!.sentToMemberAt).toBeNull();
    expect(harness.store.outbox.rows()).toHaveLength(0);
    const refusal = harness.audit.events.filter((e) => e.eventType === 'broadcast_body_image_source_unsafe');
    expect(refusal.map((e) => e.payload)).toEqual([{ unsafeImageSources: [SRC] }]);
    expect(harness.audit.events.map((e) => e.eventType)).not.toContain('broadcast_version_sent_to_member');

    // Still editable: marketing replaces the image and saves.
    const { PATCH } = await importVersionRoute();
    const saved = await PATCH(
      patchVersionRequest(ID, {
        subject: WORKING.subject,
        bodyHtml: `<p>Hello</p><img src="${OK_SRC}" alt="Logo">`,
        bodySource: WORKING.bodySource,
        noteToMember: null,
        expectedUpdatedAt: WORKING.updatedAt.toISOString(),
      }),
      routeParams(ID),
    );
    expect(saved.status).toBe(200);
  });
});

describe('promotion on POST …/schedule is refused with the same code', () => {
  const APPROVED_VERSION = makeApprovalVersion({ versionNo: 1, bodyHtml: BODY, sentToMemberAt: new Date('2026-09-21T08:00:00Z') });
  const MEMBER_APPROVED = makeApprovalBroadcast({ status: 'member_approved', currentRound: 1, approvedVersionId: APPROVED_VERSION.id });
  beforeEach(() => {
    resetVersionHarness({ broadcasts: [MEMBER_APPROVED], versions: [V0, APPROVED_VERSION] });
    harness.allowlistHosts = [HOST, 'cdn.resend.dev'];
  });

  it('with the host still allowed the promotion goes through (the positive control)', async () => {
    const { POST } = await importScheduleRoute();
    expect((await POST(postScheduleRequest(ID, { mode: 'send_now' }), routeParams(ID))).status).toBe(200);
    expect(rowOf().bodyHtml).toBe(BODY);
  });

  it('host removed → 422 naming the image; the E-Blast stays Member approved, nothing promoted, nothing enqueued', async () => {
    hostRemoved();
    const { POST } = await importScheduleRoute();
    const res = await POST(postScheduleRequest(ID, { mode: 'send_now' }), routeParams(ID));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('image_source_not_allowlisted');
    expect(body.error.details).toEqual({ images: REFUSED_IMAGES });
    expect(rowOf()).toEqual(MEMBER_APPROVED);
    expect(harness.store.outbox.rows()).toHaveLength(0);
    expect(harness.audit.events.map((e) => e.eventType)).toEqual(['broadcast_body_image_source_unsafe']);
  });

  it('a time change on an ALREADY promoted row does not re-check (no content moves)', async () => {
    resetVersionHarness({
      broadcasts: [{ ...MEMBER_APPROVED, status: 'approved', bodyHtml: BODY }],
      versions: [V0, APPROVED_VERSION],
    });
    hostRemoved();
    const { POST } = await importScheduleRoute();
    const res = await POST(
      postScheduleRequest(ID, { mode: 'schedule', scheduledFor: new Date(harness.store.now.getTime() + 3_600_000).toISOString() }),
      routeParams(ID),
    );
    expect(res.status).toBe(200);
  });
});
