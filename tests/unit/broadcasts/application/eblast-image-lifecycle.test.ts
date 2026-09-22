/**
 * F119 review findings F2-1 and F2-10 — the image row/blob lifecycle.
 *
 * F2-1 (PDPA BLOCKER). `broadcast_images.owner_id` has no FK, so nothing in
 * the database reacts when an owner row is HARD-deleted. Two paths hard-delete
 * one — "Discard draft" and the daily `pruneExpiredDrafts` — and neither
 * touched the image rows. The sweep reads `deleted_at IS NOT NULL`, so an
 * un-stamped row is invisible to it forever: the member's photograph stays at
 * a public, unauthenticated blob URL that no code path can ever remove,
 * including the Art. 17 / §33 erasure cascade.
 *
 * F2-10 (reliability + migration). The sweep counted live rows and then
 * deleted the blob with no lock, so a dedup insert landing between the two
 * left a LIVE row pointing at a 404. And blobs uploaded before 0304 have no
 * row at all but are still referenced by old `body_html` — a later dedup row
 * being marked would delete them out from under a live E-Blast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { markOwnerImagesRemoved } from '@/modules/broadcasts/application/use-cases/_mark-owner-images-removed';
import { reclaimOrphanedImages } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-images';
import { pruneExpiredDrafts } from '@/modules/broadcasts/application/use-cases/prune-expired-drafts';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import {
  FAKE_TX,
  makeFakeBroadcastImagesRepo,
  makeFakeImageStorage,
} from '../../../helpers/eblast-approval-fakes';

const TENANT = 'tenant-swe' as never;
const NOW = new Date('2026-09-22T03:00:00Z');
const DRAFT = '11111111-1111-1111-1111-111111111111';
const MEMBER = '22222222-2222-2222-2222-222222222222';

function makeAudit(): AuditPort & { events: Array<{ tx: unknown; eventType: string; payload: Record<string, unknown> }> } {
  const events: Array<{ tx: unknown; eventType: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    emit: vi.fn(async (tx: unknown, e) => {
      events.push({ tx, eventType: e.eventType, payload: e.payload });
    }),
    emitTyped: vi.fn(async (tx: unknown, e) => {
      events.push({ tx, eventType: e.eventType, payload: e.payload as Record<string, unknown> });
    }),
  } as never;
}

function imageRow(over: Partial<BroadcastImageRecord> = {}): BroadcastImageRecord {
  return {
    id: 'img-seed',
    tenantId: 'tenant-swe',
    ownerKind: 'broadcast',
    ownerId: DRAFT,
    contentHash: 'hash-a',
    blobUrl: 'https://assets.swecham.zyncdata.app/broadcasts/images/tenant-swe/hash-a.png',
    blobKey: 'broadcasts/images/tenant-swe/hash-a.png',
    mimeType: 'image/png',
    byteSize: 1024,
    uploadedByUserId: 'u-1',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// F2-1 — the shared stamp helper
// ---------------------------------------------------------------------------
describe('markOwnerImagesRemoved — F2-1', () => {
  it('stamps every live image of the owner IN THE CALLER\'S tx and audits one row each', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([
      imageRow({ id: 'img-1', contentHash: 'hash-a' }),
      imageRow({ id: 'img-2', contentHash: 'hash-b' }),
      imageRow({ id: 'img-other', ownerId: 'other-draft' }),
    ]);
    const audit = makeAudit();
    const CALLER_TX = Symbol('caller-tx');

    const n = await markOwnerImagesRemoved(
      { imagesRepo, audit },
      {
        tenantId: TENANT,
        owner: { kind: 'broadcast', id: DRAFT },
        reason: 'draft_discarded',
        at: NOW,
        requestId: 'req-1',
        actorUserId: 'u-1',
        actorRole: 'member',
        relatedMemberId: MEMBER,
      },
      CALLER_TX,
    );

    expect(n).toBe(2);
    // Same tx object for the stamp AND for every audit row — the co-commit.
    expect(vi.mocked(imagesRepo.markDeletedByOwner).mock.calls[0]![3]).toBe(CALLER_TX);
    expect(audit.events.map((e) => e.tx)).toEqual([CALLER_TX, CALLER_TX]);
    expect(audit.events.map((e) => e.eventType)).toEqual([
      'broadcast_image_removed',
      'broadcast_image_removed',
    ]);
    expect(audit.events[0]!.payload).toMatchObject({
      related_member_id: MEMBER,
      owner_kind: 'broadcast',
      owner_id: DRAFT,
      image_id: 'img-1',
      content_hash: 'hash-a',
      blob_deleted: false,
      reason: 'draft_discarded',
      actor_role: 'member',
    });
    // The other owner's image is untouched.
    expect(imagesRepo.rows.find((r) => r.id === 'img-other')!.deletedAt).toBeNull();
  });

  it('carries related_member_id, never snake_case member_id (a deletion is not member activity)', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([imageRow({ id: 'img-1' })]);
    const audit = makeAudit();
    await markOwnerImagesRemoved(
      { imagesRepo, audit },
      {
        tenantId: TENANT,
        owner: { kind: 'broadcast', id: DRAFT },
        reason: 'draft_pruned',
        at: NOW,
        requestId: 'r',
        actorUserId: 'system',
        actorRole: 'system',
        relatedMemberId: MEMBER,
      },
      FAKE_TX,
    );
    expect(Object.keys(audit.events[0]!.payload)).not.toContain('member_id');
  });

  it('an audit-emit failure propagates so the caller\'s tx rolls the stamp back', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([imageRow({ id: 'img-1' })]);
    const audit = makeAudit();
    vi.mocked(audit.emit).mockRejectedValueOnce(new Error('audit down'));
    await expect(
      markOwnerImagesRemoved(
        { imagesRepo, audit },
        {
          tenantId: TENANT,
          owner: { kind: 'broadcast', id: DRAFT },
          reason: 'draft_discarded',
          at: NOW,
          requestId: 'r',
          actorUserId: 'u',
          actorRole: null,
          relatedMemberId: null,
        },
        FAKE_TX,
      ),
    ).rejects.toThrow('audit down');
  });
});

// ---------------------------------------------------------------------------
// F2-1 — the daily prune
// ---------------------------------------------------------------------------
describe('pruneExpiredDrafts — F2-1: a pruned draft takes its images with it', () => {
  it('stamps + audits the images of every pruned draft, in the SAME tx as the DELETE', async () => {
    const imagesRepo = makeFakeBroadcastImagesRepo([
      imageRow({ id: 'img-1', ownerId: 'draft-a' }),
      imageRow({ id: 'img-2', ownerId: 'draft-b', contentHash: 'hash-b' }),
      imageRow({ id: 'img-live', ownerId: 'draft-kept' }),
    ]);
    const audit = makeAudit();
    const TX = Symbol('prune-tx');
    const broadcastsRepo = {
      withTx: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn(TX)),
      pruneExpiredDrafts: vi.fn(async () => ({
        prunedCount: 2,
        prunedDrafts: [
          { broadcastId: 'draft-a', requestedByMemberId: MEMBER },
          { broadcastId: 'draft-b', requestedByMemberId: null },
        ],
      })),
    } as never;

    const r = await pruneExpiredDrafts({
      tenant: { slug: 'tenant-swe' } as never,
      broadcastsRepo,
      imagesRepo,
      audit,
      clock: { now: () => NOW } as never,
      requestId: 'cron-prune-1',
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.prunedCount).toBe(2);
    // The DELETE and both stamps share one transaction.
    expect(vi.mocked(imagesRepo.markDeletedByOwner).mock.calls.map((c) => c[3])).toEqual([TX, TX]);
    expect(audit.events.map((e) => e.tx)).toEqual([TX, TX]);
    expect(audit.events.map((e) => e.payload['reason'])).toEqual(['draft_pruned', 'draft_pruned']);
    expect(audit.events.map((e) => e.payload['related_member_id'])).toEqual([MEMBER, null]);
    // The cron has no session: 'system', never a fabricated role.
    expect(audit.events.map((e) => e.payload['actor_role'])).toEqual(['system', 'system']);
    // A draft that was not pruned keeps its image live.
    expect(imagesRepo.rows.find((r2) => r2.id === 'img-live')!.deletedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F2-1 / F2-10 — the sweep
// ---------------------------------------------------------------------------
describe('reclaimOrphanedImages — F2-1 orphan arm + F2-10 races', () => {
  let audit: ReturnType<typeof makeAudit>;
  beforeEach(() => {
    audit = makeAudit();
  });

  it('F2-1 defence in depth: a LIVE row whose owner no longer exists is reaped too', async () => {
    const orphan = imageRow({ id: 'img-orphan', ownerId: 'deleted-draft', deletedAt: null });
    const imagesRepo = makeFakeBroadcastImagesRepo([orphan]);
    // Nothing is MARKED; the orphan is only visible to the new arm.
    vi.mocked(imagesRepo.listMarked).mockResolvedValue([]);
    vi.mocked(imagesRepo.listOrphaned).mockResolvedValue([orphan]);
    const storage = makeFakeImageStorage();

    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 'sweep-1' },
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ rowsRemoved: 1, blobsDeleted: 1 });
    expect(storage.deleted).toEqual([orphan.blobKey]);
    expect(audit.events[0]!.payload).toMatchObject({
      image_id: 'img-orphan',
      blob_deleted: true,
      reason: 'sweep_orphaned',
      actor_role: 'system',
    });
  });

  it('F2-10(a): the per-row tx takes the content-hash advisory lock BEFORE counting live rows', async () => {
    const marked = imageRow({ id: 'img-1', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([marked]);
    const order: string[] = [];
    vi.mocked(imagesRepo.lockContentHash).mockImplementation(async () => {
      order.push('lock');
    });
    vi.mocked(imagesRepo.countLiveByContentHash).mockImplementation(async () => {
      order.push('count');
      return 0;
    });
    const storage = makeFakeImageStorage();

    await reclaimOrphanedImages({ imagesRepo, storage, audit }, { tenantId: TENANT, now: NOW, requestId: 's' });

    expect(order).toEqual(['lock', 'count']);
    expect(vi.mocked(imagesRepo.lockContentHash).mock.calls[0]![1]).toBe('hash-a');
  });

  it('F2-10(b): a blob still referenced by live content keeps its BYTES; the row still goes', async () => {
    const marked = imageRow({ id: 'img-1', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([marked]);
    vi.mocked(imagesRepo.countLiveByContentHash).mockResolvedValue(0);
    vi.mocked(imagesRepo.isBlobReferencedByContent).mockResolvedValue(true);
    const storage = makeFakeImageStorage();

    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );

    expect(storage.deleted).toEqual([]);
    if (r.ok) expect(r.value).toMatchObject({ rowsRemoved: 1, blobsDeleted: 0 });
    expect(audit.events[0]!.payload).toMatchObject({
      blob_deleted: false,
      reason: 'sweep_referenced',
    });
    expect(vi.mocked(imagesRepo.isBlobReferencedByContent).mock.calls[0]![1]).toBe(marked.blobUrl);
  });

  it('F2-10 (LOW): two marked rows sharing one hash delete the blob ONCE and count it once', async () => {
    const a = imageRow({ id: 'img-1', deletedAt: NOW });
    const b = imageRow({ id: 'img-2', ownerId: 'draft-2', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([a, b]);
    vi.mocked(imagesRepo.countLiveByContentHash).mockResolvedValue(0);
    const storage = makeFakeImageStorage();

    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );

    expect(storage.deleted).toEqual([a.blobKey]);
    if (r.ok) expect(r.value).toMatchObject({ scanned: 2, rowsRemoved: 2, blobsDeleted: 1 });
    // Both rows are audited; only the first says the bytes went.
    expect(audit.events.map((e) => e.payload['blob_deleted'])).toEqual([true, false]);
  });

  it('the last-reference rule still holds: a live sibling row keeps the blob', async () => {
    const marked = imageRow({ id: 'img-1', deletedAt: NOW });
    const imagesRepo = makeFakeBroadcastImagesRepo([marked, imageRow({ id: 'img-live', ownerId: 'other' })]);
    const storage = makeFakeImageStorage();
    const r = await reclaimOrphanedImages(
      { imagesRepo, storage, audit },
      { tenantId: TENANT, now: NOW, requestId: 's' },
    );
    expect(storage.deleted).toEqual([]);
    if (r.ok) expect(r.value).toMatchObject({ rowsRemoved: 1, blobsDeleted: 0 });
  });
});
