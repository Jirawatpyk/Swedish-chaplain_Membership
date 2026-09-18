/**
 * F119 T033 — Drizzle adapter for `BroadcastImagesRepo` (migration 0304).
 *
 * Every query runs on the caller's tenant `tx` (`withTenantTxOrOpen`) —
 * never the pool-global `db`, which would bypass RLS + FORCE silently (the
 * F7.1a US2 rule). Drizzle-inferred row types stay inside this file.
 */
import { and, count, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { runInTenant, withTenantTxOrOpen, type TenantTx } from '@/lib/db';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import type {
  BroadcastImageOwnerKind,
  BroadcastImageRecord,
  BroadcastImagesRepo,
  BroadcastImagesTx,
  NewBroadcastImage,
} from '../../application/ports/broadcast-images-repo';
import type { ImageMimeType } from '../../application/ports/image-storage-port';
import { broadcastImages, type BroadcastImageRow } from '../schema';

function toRecord(row: BroadcastImageRow): BroadcastImageRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerKind: row.ownerKind as BroadcastImageOwnerKind,
    ownerId: row.ownerId,
    contentHash: row.contentHash,
    blobUrl: row.blobUrl,
    blobKey: row.blobKey,
    mimeType: row.mimeType as ImageMimeType,
    byteSize: row.byteSize,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

export const drizzleBroadcastImagesRepo: BroadcastImagesRepo = {
  async withTx<T>(tenantId: TenantSlug, fn: (tx: BroadcastImagesTx) => Promise<T>): Promise<T> {
    return runInTenant(asTenantContext(tenantId as unknown as string), async (tx) => fn(tx));
  },

  async record(tenantId: TenantSlug, input: NewBroadcastImage, tx: BroadcastImagesTx): Promise<BroadcastImageRecord> {
    const rows = await (tx as TenantTx)
      .insert(broadcastImages)
      .values({
        tenantId: tenantId as string,
        ownerKind: input.ownerKind,
        ownerId: input.ownerId,
        contentHash: input.contentHash,
        blobUrl: input.blobUrl,
        blobKey: input.blobKey,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        uploadedByUserId: input.uploadedByUserId,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('broadcast_images_insert_returned_no_row');
    return toRecord(row);
  },

  async listByOwner(tenantId, owner, tx) {
    return withTenantTxOrOpen(tenantId, tx ?? null, async (inner: TenantTx) => {
      const rows = await inner
        .select()
        .from(broadcastImages)
        .where(
          and(
            eq(broadcastImages.tenantId, tenantId as string),
            eq(broadcastImages.ownerKind, owner.kind),
            eq(broadcastImages.ownerId, owner.id),
            isNull(broadcastImages.deletedAt),
          ),
        )
        .orderBy(desc(broadcastImages.createdAt));
      return rows.map(toRecord);
    });
  },

  async markDeletedByOwner(tenantId, owner, at, tx) {
    const rows = await (tx as TenantTx)
      .update(broadcastImages)
      .set({ deletedAt: at })
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          eq(broadcastImages.ownerKind, owner.kind),
          eq(broadcastImages.ownerId, owner.id),
          isNull(broadcastImages.deletedAt),
        ),
      )
      .returning();
    return rows.map(toRecord);
  },

  async listMarked(tenantId, limit, tx) {
    const rows = await (tx as TenantTx)
      .select()
      .from(broadcastImages)
      .where(and(eq(broadcastImages.tenantId, tenantId as string), isNotNull(broadcastImages.deletedAt)))
      .orderBy(broadcastImages.deletedAt)
      .limit(limit);
    return rows.map(toRecord);
  },

  async countLiveByContentHash(tenantId, contentHash, tx) {
    const rows = await (tx as TenantTx)
      .select({ n: count() })
      .from(broadcastImages)
      .where(
        and(
          eq(broadcastImages.tenantId, tenantId as string),
          eq(broadcastImages.contentHash, contentHash),
          isNull(broadcastImages.deletedAt),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  },

  async remove(tenantId, imageId, tx) {
    await (tx as TenantTx)
      .delete(broadcastImages)
      .where(and(eq(broadcastImages.tenantId, tenantId as string), eq(broadcastImages.id, imageId)));
  },
};
