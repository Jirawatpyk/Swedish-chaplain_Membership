/**
 * F119 T035 — `reclaimOrphanedImages`: the daily image-blob sweep
 * (data-model § 4; spec § Personal data — "the stored file is deleted by
 * the daily sweep within 24 hours once nothing references it").
 *
 * A row is MARKED (`deleted_at IS NOT NULL`) by erasure, a member
 * withdrawal or a staff rejection, each inside its own state-changing tx
 * (T081 / T082, PR-2). This sweep reaps marked rows under the
 * LAST-REFERENCE rule: the blob is deleted iff no LIVE row of EITHER
 * owner_kind — no E-Blast and no template — shares its `content_hash`
 * (a template image referenced by a draft is kept). The row is then
 * removed and `broadcast_image_removed { …, blob_deleted, reason: 'sweep',
 * actor_role: 'system' }` is audited in the same tx.
 *
 * A blob delete that throws leaves the row in place — tomorrow's tick
 * retries — and audits nothing; a row is never removed twice. One
 * transaction per row so one bad blob never blocks the batch. Bounded per
 * tick; a second run the same day is a no-op.
 */
import { err, ok, type Result } from '@/lib/result';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import type { TenantSlug } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { ImageStoragePort } from '../ports/image-storage-port';

export const IMAGE_SWEEP_BATCH = 200;

export interface ReclaimOrphanedImagesDeps {
  readonly imagesRepo: BroadcastImagesRepo;
  readonly storage: Pick<ImageStoragePort, 'delete'>;
  readonly audit: AuditPort;
}

export interface ReclaimOrphanedImagesInput {
  readonly tenantId: TenantSlug;
  readonly now: Date;
  readonly requestId: string;
}

export interface ReclaimOrphanedImagesOutput {
  readonly scanned: number;
  readonly blobsDeleted: number;
  readonly rowsRemoved: number;
}

export type ReclaimOrphanedImagesError = {
  readonly kind: 'sweep.server_error';
  readonly message: string;
};

export async function reclaimOrphanedImages(
  deps: ReclaimOrphanedImagesDeps,
  input: ReclaimOrphanedImagesInput,
): Promise<Result<ReclaimOrphanedImagesOutput, ReclaimOrphanedImagesError>> {
  let marked;
  try {
    marked = await deps.imagesRepo.withTx(input.tenantId, (tx) =>
      deps.imagesRepo.listMarked(input.tenantId, IMAGE_SWEEP_BATCH, tx),
    );
  } catch (e) {
    return err({ kind: 'sweep.server_error', message: e instanceof Error ? e.message : String(e) });
  }

  let blobsDeleted = 0;
  let rowsRemoved = 0;
  for (const image of marked) {
    try {
      const removed = await deps.imagesRepo.withTx(input.tenantId, async (tx) => {
        const live = await deps.imagesRepo.countLiveByContentHash(input.tenantId, image.contentHash, tx);
        let blobDeleted = false;
        if (live === 0) {
          // A throw here propagates: the row stays for the next tick.
          await deps.storage.delete(image.blobKey);
          blobDeleted = true;
        }
        await deps.imagesRepo.remove(input.tenantId, image.id, tx);
        await deps.audit.emit(tx, {
          eventType: 'broadcast_image_removed',
          tenantId: input.tenantId,
          requestId: input.requestId,
          actorUserId: 'system',
          summary: `E-Blast image swept (${blobDeleted ? 'blob deleted' : 'blob kept by reference'})`,
          payload: {
            related_member_id: null,
            owner_kind: image.ownerKind,
            owner_id: image.ownerId,
            image_id: image.id,
            content_hash: image.contentHash,
            blob_deleted: blobDeleted,
            reason: 'sweep',
            actor_role: 'system',
          },
        });
        return blobDeleted;
      });
      rowsRemoved += 1;
      if (removed) blobsDeleted += 1;
    } catch (e) {
      logger.warn(
        { err: errKind(e), tenantId: input.tenantId, imageId: image.id, requestId: input.requestId },
        'broadcasts.image_sweep.row_retry_next_tick',
      );
    }
  }
  return ok({ scanned: marked.length, blobsDeleted, rowsRemoved });
}
