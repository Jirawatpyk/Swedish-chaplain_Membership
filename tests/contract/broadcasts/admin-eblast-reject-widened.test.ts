/**
 * F119 T081 — the widened staff `POST /api/admin/broadcasts/[id]/reject` and
 * `…/cancel` and the member `POST /api/broadcasts/[id]/cancel`
 * (contracts/admin-eblast-formatting-api.md § reject/cancel;
 * portal-eblast-approval-api.md § cancel; data-model §§ 4, 8.2; FR-015,
 * FR-020, US2-AS5).
 *
 *   - accepted from every in-progress stage the state machine gives a
 *     `rejected` / `cancelled` exit; from `sending` onward → 409
 *     `sending_started` and the send completes;
 *   - in the SAME transaction, every live `broadcast_images` row of the
 *     E-Blast is stamped and audited `broadcast_image_removed` with reason
 *     `'rejected'` / `'withdrawn'` — the bytes go on the sweep's next tick
 *     under the last-reference rule;
 *   - both staff routes name `broadcasts.write`; the staff reject takes the
 *     30 / 60 s staff bucket, consumed before anything is read. The staff
 *     cancel takes none — the bulk send-now Undo fans out one cancel per row
 *     (contract § Rate limits, whole-branch review HIGH-3).
 *
 * The routes run the REAL `rejectBroadcast` / `cancelBroadcast` over the
 * in-memory approval store; the sweep is the REAL `reclaimOrphanedImages`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { err } from '@/lib/result';
import { reclaimOrphanedImages } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-images';
import type { BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import type { BroadcastStatus } from '@/modules/broadcasts/domain/value-objects/broadcast-status';
import { asTenantSlug } from '@/modules/tenants';
import { makeApprovalBroadcast, makeFakeBroadcastImagesRepo, makeFakeImageStorage } from '../../helpers/eblast-approval-fakes';
import {
  HARNESS_MEMBER_ID,
  MARKETING_USER_ID,
  harness,
  importMemberCancelRoute,
  importStaffCancelRoute,
  importStaffRejectRoute,
  postMemberCancelRequest,
  postStaffRequest,
  resetVersionHarness,
  routeParams,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/auth-session', async () => (await import('../../helpers/eblast-version-route-harness')).authSessionMock());
vi.mock('@/lib/member-context', async () => (await import('../../helpers/eblast-version-route-harness')).memberContextMock());
vi.mock('@/lib/broadcast-marketing-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).marketingDepsMock(),
);
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);

const ID = makeApprovalBroadcast().broadcastId as string;
const KEY = `test-tenant::${ID}`;
const REASON = 'Not suitable for the member newsletter';

const image = (overrides: Partial<BroadcastImageRecord>): BroadcastImageRecord => ({
  id: 'img-1',
  tenantId: 'test-tenant',
  ownerKind: 'broadcast',
  ownerId: ID,
  contentHash: 'hash-1',
  blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/test-tenant/hash-1.png',
  blobKey: 'broadcasts/images/test-tenant/hash-1.png',
  mimeType: 'image/png',
  byteSize: 1234,
  uploadedByUserId: '33333333-3333-4333-8333-333333333333',
  createdAt: new Date('2026-09-18T00:00:00Z'),
  deletedAt: null,
  ...overrides,
});

const seed = (status: BroadcastStatus, images: readonly BroadcastImageRecord[] = []) => {
  resetVersionHarness({ broadcasts: [makeApprovalBroadcast({ status, currentRound: status === 'submitted' ? 0 : 1 })] });
  harness.images = makeFakeBroadcastImagesRepo(images);
};
const row = () => harness.store.state.broadcasts.get(KEY)!;
const reject = async () => (await importStaffRejectRoute()).POST(postStaffRequest(ID, 'reject', { rejectionReason: REASON }), routeParams(ID));
const staffCancel = async () =>
  (await importStaffCancelRoute()).POST(postStaffRequest(ID, 'cancel', { cancellationReason: REASON }), routeParams(ID));
const memberCancel = async () => (await importMemberCancelRoute()).POST(postMemberCancelRequest(ID, {}), routeParams(ID));

beforeEach(() => seed('submitted'));

describe('reject — widened to every in-progress stage with a `rejected` exit (FR-015)', () => {
  it.each(['submitted', 'in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved'] as const)(
    'reject from %s → 200, the allowance place freed (status rejected)',
    async (status) => {
      seed(status);
      const res = await reject();
      expect(res.status).toBe(200);
      expect(row()).toMatchObject({ status: 'rejected', rejectionReason: REASON });
    },
  );

  it.each(['sending', 'sent', 'partially_sent', 'partial_delivery_accepted'] as const)(
    'reject from %s → 409 sending_started, nothing changes',
    async (status) => {
      seed(status);
      const res = await reject();
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('sending_started');
      expect(row().status).toBe(status);
    },
  );

  it.each(['approved', 'failed_to_dispatch', 'rejected', 'cancelled', 'expired_no_member_response', 'draft'] as const)(
    'reject from %s → 409 broadcast_invalid_state_transition (approved has no rejected exit in the state machine — cancel it instead, data-model § 8.2; a failed dispatch never handed the send over, so "the send completes" would be false)',
    async (status) => {
      seed(status);
      const res = await reject();
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('broadcast_invalid_state_transition');
      expect(row().status).toBe(status);
    },
  );

  it('names broadcasts.write on the gate', async () => {
    await reject();
    expect(harness.requireApiPermission.mock.calls[0]![1]).toBe('broadcasts.write');
  });
});

describe('cancel — widened to every in-progress stage (FR-015)', () => {
  it.each(['submitted', 'approved', 'in_design', 'awaiting_member_approval', 'changes_requested', 'member_approved'] as const)(
    'staff cancel from %s → 200',
    async (status) => {
      seed(status);
      expect((await staffCancel()).status).toBe(200);
      expect(row().status).toBe('cancelled');
    },
  );

  it.each(['sending', 'sent'] as const)('staff cancel and member withdrawal from %s → 409 sending_started', async (status) => {
    seed(status);
    const staff = await staffCancel();
    expect(staff.status).toBe(409);
    expect((await staff.json()).error.code).toBe('sending_started');
    const member = await memberCancel();
    expect(member.status).toBe(409);
    expect((await member.json()).error.code).toBe('sending_started');
    expect(row().status).toBe(status);
  });

  it('a closed E-Blast that never started sending (rejected / cancelled / expired) keeps the existing 409 broadcast_cancel_too_late', async () => {
    for (const status of ['rejected', 'cancelled', 'expired_no_member_response', 'failed_to_dispatch'] as const) {
      seed(status);
      const res = await staffCancel();
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe('broadcast_cancel_too_late');
    }
  });

  it('the staff cancel route names broadcasts.write on the gate (check:api-route-guard)', async () => {
    await staffCancel();
    expect(harness.requireApiPermission.mock.calls[0]![1]).toBe('broadcasts.write');
  });
});

describe('images of a rejected or withdrawn E-Blast stop being reachable (US2-AS5, spec § Personal data)', () => {
  const two = () => [image({ id: 'img-1' }), image({ id: 'img-2', contentHash: 'hash-2', blobKey: 'broadcasts/images/test-tenant/hash-2.png' })];

  it("a reject stamps every image row of the E-Blast in the same transaction and emits broadcast_image_removed with reason 'rejected'", async () => {
    seed('awaiting_member_approval', [...two(), image({ id: 'img-other', ownerId: '99999999-9999-4999-8999-999999999999' })]);
    expect((await reject()).status).toBe(200);
    const stamped = harness.images.rows.filter((r) => r.deletedAt !== null).map((r) => r.id);
    expect(stamped.sort()).toEqual(['img-1', 'img-2']);
    const removed = harness.audit.events.filter((e) => e.eventType === 'broadcast_image_removed');
    expect(removed.map((e) => e.payload)).toEqual(
      ['img-1', 'img-2'].map((id, i) => ({
        related_member_id: HARNESS_MEMBER_ID,
        owner_kind: 'broadcast',
        owner_id: ID,
        image_id: id,
        content_hash: i === 0 ? 'hash-1' : 'hash-2',
        blob_deleted: false,
        reason: 'rejected',
        actor_role: 'marketing',
      })),
    );
    expect(removed.every((e) => e.tx === 'fake-tx')).toBe(true);
    expect(removed.every((e) => e.actorUserId === MARKETING_USER_ID)).toBe(true);
  });

  it("a member withdrawal emits reason 'withdrawn' with the member's session role; a staff cancel likewise with the staff role", async () => {
    seed('in_design', two());
    expect((await memberCancel()).status).toBe(200);
    const memberRows = harness.audit.events.filter((e) => e.eventType === 'broadcast_image_removed');
    expect(memberRows).toHaveLength(2);
    expect(memberRows.every((e) => (e.payload as { reason: string }).reason === 'withdrawn')).toBe(true);
    expect(memberRows.every((e) => (e.payload as { actor_role: string }).actor_role === 'member')).toBe(true);

    seed('in_design', two());
    expect((await staffCancel()).status).toBe(200);
    const staffRows = harness.audit.events.filter((e) => e.eventType === 'broadcast_image_removed');
    expect(staffRows.map((e) => (e.payload as { reason: string; actor_role: string }))).toEqual([
      expect.objectContaining({ reason: 'withdrawn', actor_role: 'marketing' }),
      expect.objectContaining({ reason: 'withdrawn', actor_role: 'marketing' }),
    ]);
  });

  it('an image whose hash is still referenced by a template is stamped but NOT deleted by the sweep (last-reference rule)', async () => {
    const shared = image({ id: 'img-shared', contentHash: 'hash-shared', blobKey: 'broadcasts/images/test-tenant/hash-shared.png' });
    const template = image({ id: 'img-template', ownerKind: 'template', ownerId: 'tpl-1', contentHash: 'hash-shared', blobKey: shared.blobKey });
    const own = image({ id: 'img-own', contentHash: 'hash-own', blobKey: 'broadcasts/images/test-tenant/hash-own.png' });
    seed('awaiting_member_approval', [shared, template, own]);
    expect((await reject()).status).toBe(200);
    expect(harness.images.rows.find((r) => r.id === 'img-shared')!.deletedAt).not.toBeNull();
    expect(harness.images.rows.find((r) => r.id === 'img-template')!.deletedAt).toBeNull();

    const storage = makeFakeImageStorage();
    const swept = await reclaimOrphanedImages(
      { imagesRepo: harness.images, storage, audit: harness.audit },
      { tenantId: asTenantSlug('test-tenant'), now: new Date('2026-09-25T00:00:00Z'), requestId: 'sweep-1' },
    );
    expect(swept.ok).toBe(true);
    expect(storage.deleted).toEqual(['broadcasts/images/test-tenant/hash-own.png']);
    expect(harness.images.rows.map((r) => r.id).sort()).toEqual(['img-template']);
  });

  it('a refused reject (sending_started) stamps nothing', async () => {
    seed('sending', two());
    await reject();
    expect(harness.images.rows.every((r) => r.deletedAt === null)).toBe(true);
    expect(harness.audit.events.filter((e) => e.eventType === 'broadcast_image_removed')).toHaveLength(0);
  });
});

describe('the staff write bucket on the widened staff reject — 30 / 60 s per (tenant, actor); cancel carries none', () => {
  it('the 31st staff reject in a minute → 429 broadcast_rate_limit_exceeded with Retry-After, with no stage change and no image row stamped', async () => {
    seed('awaiting_member_approval', [image({})]);
    harness.checkLimit.mockResolvedValue(err({ retryAfterSeconds: 23 }));
    const res = await reject();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('23');
    const body = await res.json();
    expect(body.error.code).toBe('broadcast_rate_limit_exceeded');
    expect(body.error.details).toEqual({ retryAfterSeconds: 23 });
    expect(harness.checkLimit).toHaveBeenCalledWith(`broadcasts:staff-write:test-tenant:${MARKETING_USER_ID}`, 30, 60);
    expect(row().status).toBe('awaiting_member_approval');
    expect(harness.images.rows[0]!.deletedAt).toBeNull();
    expect(harness.store.broadcastsRepo.withTx).not.toHaveBeenCalled();
  });

  /**
   * Whole-branch review HIGH-3 — the staff …/cancel carries NO bucket. The
   * bulk send-now Undo fans out one cancel per approved row (`BULK_CAP` 100)
   * from one actor, so a 30 / 60 s bucket answered rows 31+ with 429 and they
   * dispatched although the admin had clicked Undo (contract § Rate limits).
   */
  it('the staff …/cancel is NOT bucketed: with the staff bucket exhausted it still cancels, and never consumes a call', async () => {
    seed('in_design', [image({})]);
    harness.checkLimit.mockResolvedValue(err({ retryAfterSeconds: 5 }));
    const res = await staffCancel();
    expect(res.status).toBe(200);
    expect(harness.checkLimit).not.toHaveBeenCalled();
    expect(row().status).toBe('cancelled');
  });

  it('a manager is refused by the gate before the bucket is touched', async () => {
    harness.requireApiPermission.mockResolvedValue({ response: new Response(null, { status: 403 }) });
    expect((await reject()).status).toBe(403);
    expect((await staffCancel()).status).toBe(403);
    expect(harness.checkLimit).not.toHaveBeenCalled();
    expect(row().status).toBe('submitted');
  });
});
