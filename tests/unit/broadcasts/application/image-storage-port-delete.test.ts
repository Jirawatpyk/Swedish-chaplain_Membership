/**
 * F119 T034 / T035 — `reclaimOrphanedImages` and the widened
 * `ImageStoragePort.delete(key)` (data-model § 4, the LAST-REFERENCE rule).
 *
 * A marked row (`deleted_at IS NOT NULL`) is reaped by the daily sweep:
 * the blob is deleted IFF no LIVE row of EITHER owner_kind — no E-Blast and
 * no template — shares its `content_hash`; the row is then removed and
 * `broadcast_image_removed { …, blob_deleted, reason: 'sweep',
 * actor_role: 'system' }` is audited. Before F119 the port had no delete
 * method at all, so inline-image blobs were never reclaimed.
 *
 * The sweep IS the only caller of `delete`, so T034 (the port method) and
 * the use-case half of T035 share this suite; the cron ROUTE half of T035
 * is `tests/contract/broadcasts/eblast-image-sweep-cron.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// F7-1 — a row that throws must be ALERTABLE, not only a `warn` line.
const { imageSweepRowFailedSpy } = vi.hoisted(() => ({ imageSweepRowFailedSpy: vi.fn() }));
vi.mock('@/lib/metrics', async () => {
  const actual = await vi.importActual<typeof import('@/lib/metrics')>('@/lib/metrics');
  return {
    ...actual,
    broadcastsMetrics: { ...actual.broadcastsMetrics, imageSweepRowFailed: imageSweepRowFailedSpy },
  };
});

import { reclaimOrphanedImages } from '@/modules/broadcasts/application/use-cases/reclaim-orphaned-images';
import type { BroadcastImagesRepo, BroadcastImageRecord } from '@/modules/broadcasts/application/ports/broadcast-images-repo';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { ImageStoragePort } from '@/modules/broadcasts/application/ports/image-storage-port';

const TENANT = 'tenant-swe' as never;
const NOW = new Date('2026-09-18T04:30:00Z');

function marked(id: string, contentHash: string, ownerKind: 'broadcast' | 'template' = 'broadcast'): BroadcastImageRecord {
  return {
    id,
    tenantId: TENANT,
    ownerKind,
    ownerId: '11111111-1111-1111-1111-111111111111',
    contentHash,
    blobUrl: `https://blob.example/${contentHash}.png`,
    blobKey: `broadcasts/images/tenant-swe/${contentHash}.png`,
    mimeType: 'image/png',
    byteSize: 100,
    uploadedByUserId: 'user-1',
    createdAt: NOW,
    deletedAt: NOW,
  };
}

function makeDeps(rows: BroadcastImageRecord[], liveCounts: Record<string, number>) {
  const imagesRepo: BroadcastImagesRepo = {
    withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn('tx-1')),
    record: vi.fn(),
    listByOwner: vi.fn(),
    markDeletedByOwner: vi.fn(),
    listMarked: vi.fn(async () => rows),
    markDeletedForMember: vi.fn(async () => []),
    listByMember: vi.fn(async () => []),
    // ROUND-2 R-M1 / S-3 — the batched prune stamp and the sweep's
    // keep-the-row arm. Unstubbed, either is an unexercised branch.
    markDeletedByOwners: vi.fn(async () => []),
    restoreLive: vi.fn(async () => undefined),
    listOrphaned: vi.fn(async () => []),
    lockContentHash: vi.fn(async () => undefined),
    isBlobReferencedByContent: vi.fn(async () => false),
    countLiveByContentHash: vi.fn(async (_t: never, hash: string) => liveCounts[hash] ?? 0),
    remove: vi.fn(async () => undefined),
    // ROUND-3 #4 — the per-row `SET LOCAL statement_timeout`. Unstubbed it is
    // an unexercised branch, and the sweep would throw before its first lock.
    setStatementTimeout: vi.fn(async () => undefined),
  };
  const storage: ImageStoragePort = {
    existsByContentHash: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(async () => undefined),
  };
  const audit: AuditPort = { emit: vi.fn(async () => undefined), emitTyped: vi.fn(async () => undefined) };
  return { imagesRepo, storage, audit };
}

describe('reclaimOrphanedImages', () => {
  beforeEach(() => {
    imageSweepRowFailedSpy.mockClear();
  });

  it('an unreferenced blob is deleted, its row removed, and the removal audited as system/sweep', async () => {
    const deps = makeDeps([marked('img-a', 'hash-a')], { 'hash-a': 0 });
    const r = await reclaimOrphanedImages(deps, { tenantId: TENANT, now: NOW, requestId: 'cron-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ scanned: 1, blobsDeleted: 1, rowsRemoved: 1, retained: 0, rowsFailed: 0 });
    expect(deps.storage.delete).toHaveBeenCalledWith('broadcasts/images/tenant-swe/hash-a.png');
    expect(deps.imagesRepo.remove).toHaveBeenCalledWith(TENANT, 'img-a', 'tx-1');
    const [, event] = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event).toMatchObject({
      eventType: 'broadcast_image_removed',
      tenantId: TENANT,
      payload: {
        related_member_id: null,
        owner_kind: 'broadcast',
        owner_id: '11111111-1111-1111-1111-111111111111',
        image_id: 'img-a',
        blob_deleted: true,
        blob_disposition: 'deleted',
        reason: 'sweep',
        actor_role: 'system',
      },
    });
    expect((event as { summary: string }).summary).toBe('E-Blast image swept (blob deleted)');
  });

  it('a blob whose hash is still referenced by a live template row is KEPT (row removed, blob not deleted)', async () => {
    const deps = makeDeps([marked('img-b', 'hash-b')], { 'hash-b': 1 });
    const r = await reclaimOrphanedImages(deps, { tenantId: TENANT, now: NOW, requestId: 'cron-1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ scanned: 1, blobsDeleted: 0, rowsRemoved: 1, retained: 0, rowsFailed: 0 });
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.imagesRepo.remove).toHaveBeenCalledTimes(1);
    const [, event] = (deps.audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(event).toMatchObject({
      summary: 'E-Blast image swept (blob kept — another live image row shares its content)',
      payload: { blob_deleted: false, blob_disposition: 'kept_shared_row' },
    });
  });

  it('a second run the same day is a no-op (nothing marked → nothing touched, nothing audited)', async () => {
    const deps = makeDeps([], {});
    const r = await reclaimOrphanedImages(deps, { tenantId: TENANT, now: NOW, requestId: 'cron-2' });
    expect(r).toEqual({ ok: true, value: { scanned: 0, blobsDeleted: 0, rowsRemoved: 0, retained: 0, rowsFailed: 0 } });
    expect(deps.storage.delete).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('the row is removed even when the blob delete throws (the blob is retried on the next tick, not the row twice)', async () => {
    const deps = makeDeps([marked('img-c', 'hash-c')], { 'hash-c': 0 });
    (deps.storage.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('blob 503'));
    const r = await reclaimOrphanedImages(deps, { tenantId: TENANT, now: NOW, requestId: 'cron-3' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The row stays so the sweep retries the delete tomorrow; nothing is audited yet.
    expect(r.value).toEqual({ scanned: 1, blobsDeleted: 0, rowsRemoved: 0, retained: 0, rowsFailed: 1 });
    expect(deps.imagesRepo.remove).not.toHaveBeenCalled();
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('F7-1: a row that throws is COUNTED and metered — an expired Blob token must not read as a clean tick', async () => {
    const deps = makeDeps([marked('img-e', 'hash-e'), marked('img-f', 'hash-f')], {});
    (deps.storage.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('blob token expired'));
    const r = await reclaimOrphanedImages(deps, { tenantId: TENANT, now: NOW, requestId: 'cron-5' });
    expect(r).toEqual({ ok: true, value: { scanned: 2, blobsDeleted: 0, rowsRemoved: 0, retained: 0, rowsFailed: 2 } });
    expect(imageSweepRowFailedSpy).toHaveBeenCalledTimes(2);
    expect(imageSweepRowFailedSpy).toHaveBeenCalledWith(TENANT);
  });

  it('the last-reference check counts LIVE rows of either owner_kind in the same tx as the removal', async () => {
    const deps = makeDeps([marked('img-d', 'hash-d', 'template')], { 'hash-d': 0 });
    await reclaimOrphanedImages(deps, { tenantId: TENANT, now: NOW, requestId: 'cron-4' });
    // F2-1 added a 4th `excludeImageId` argument. It is `undefined` on the
    // MARKED arm and set only on the ORPHAN arm, where the row being reaped is
    // itself live and would otherwise count itself and never release its blob.
    expect(deps.imagesRepo.countLiveByContentHash).toHaveBeenCalledWith(TENANT, 'hash-d', 'tx-1', undefined);
    // F2-10(a): the advisory lock is taken on the same tx, before the count.
    expect(deps.imagesRepo.lockContentHash).toHaveBeenCalledWith(TENANT, 'hash-d', 'tx-1');
  });
});
