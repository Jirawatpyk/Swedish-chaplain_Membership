/**
 * F119 T035 — `reclaimOrphanedImages`: the daily image-blob sweep
 * (data-model § 4; spec § Personal data — "the stored file is deleted by
 * the daily sweep within 24 hours once nothing references it").
 *
 * TWO ARMS.
 *
 * 1. MARKED (`deleted_at IS NOT NULL`) — the primary mechanism. A row is
 *    stamped by erasure, a member withdrawal, a staff rejection, a draft
 *    discard or the draft prune, each inside the same transaction as the
 *    state change that removed the reference.
 *
 * 2. ORPHANED (`deleted_at IS NULL`, owner row gone) — F119 review finding
 *    F2-1, defence in depth. `owner_id` carries no FK (two possible parents),
 *    so nothing in the database reacts to a hard delete. Until this arm
 *    existed, a hard-delete path that forgot to stamp left the member's
 *    photograph at a public, unauthenticated blob URL that NO code path could
 *    ever reach — not this sweep, not the Art. 17 / §33 erasure cascade. The
 *    two hard-delete paths now stamp; this arm is what stops the next one
 *    from recreating the class silently.
 *
 * THE LAST-REFERENCE RULE. A blob is deleted iff no LIVE row of EITHER
 * owner_kind shares its `content_hash` (a template image a draft uses is
 * kept) AND no live content still embeds the URL (F2-10(b) — the table was
 * not backfilled, so pre-0304 images are referenced by `body_html` with no
 * row to prove it). The row is then removed and `broadcast_image_removed` is
 * audited in the same tx.
 *
 * THE LOCK (F2-10(a)). Each per-row transaction takes
 * `pg_advisory_xact_lock` on (tenant, content_hash) BEFORE it counts. The
 * upload path takes the same lock around its insert. Without it the sweep
 * counted 0, a concurrent upload of the same file short-circuited on blob
 * EXISTENCE — the dedup probe asks storage, not the database — inserted a
 * live row, and the sweep then deleted the bytes underneath it, leaving a
 * live row pointing at a 404.
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
import type { BroadcastImageRecord, BroadcastImagesRepo } from '../ports/broadcast-images-repo';
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

/** Why this row was reaped — the audit's `reason`, one per arm/outcome. */
type SweepReason = 'sweep' | 'sweep_orphaned' | 'sweep_referenced';

export async function reclaimOrphanedImages(
  deps: ReclaimOrphanedImagesDeps,
  input: ReclaimOrphanedImagesInput,
): Promise<Result<ReclaimOrphanedImagesOutput, ReclaimOrphanedImagesError>> {
  let marked: readonly BroadcastImageRecord[];
  let orphaned: readonly BroadcastImageRecord[];
  try {
    ({ marked, orphaned } = await deps.imagesRepo.withTx(input.tenantId, async (tx) => ({
      marked: await deps.imagesRepo.listMarked(input.tenantId, IMAGE_SWEEP_BATCH, tx),
      orphaned: await deps.imagesRepo.listOrphaned(input.tenantId, IMAGE_SWEEP_BATCH, tx),
    })));
  } catch (e) {
    return err({ kind: 'sweep.server_error', message: e instanceof Error ? e.message : String(e) });
  }

  const batch: Array<{ image: BroadcastImageRecord; orphan: boolean }> = [
    ...marked.map((image) => ({ image, orphan: false })),
    ...orphaned.map((image) => ({ image, orphan: true })),
  ];

  // F2-10 (LOW) — two rows of one batch can share a `content_hash`. Before
  // this set, the second row re-issued `storage.delete` on an already-deleted
  // key and counted a second deletion, so `blobsDeleted` over-reported and the
  // operator could not tell "two blobs reclaimed" from "one blob, two rows".
  const deletedBlobKeys = new Set<string>();
  let blobsDeleted = 0;
  let rowsRemoved = 0;

  for (const { image, orphan } of batch) {
    try {
      const outcome = await deps.imagesRepo.withTx(input.tenantId, async (tx) => {
        // F2-10(a) — BEFORE the count, so an upload of the same file cannot
        // land between the count and the delete.
        await deps.imagesRepo.lockContentHash(input.tenantId, image.contentHash, tx);

        // An ORPHAN is itself a live row, so it must not count itself.
        const live = await deps.imagesRepo.countLiveByContentHash(
          input.tenantId,
          image.contentHash,
          tx,
          orphan ? image.id : undefined,
        );

        let blobDeleted = false;
        let reason: SweepReason = orphan ? 'sweep_orphaned' : 'sweep';
        if (live === 0) {
          // F2-10(b) — pre-0304 blobs have no row but ARE referenced by live
          // `body_html`. Remove the row, keep the bytes, and say so.
          const stillReferenced = await deps.imagesRepo.isBlobReferencedByContent(
            input.tenantId,
            image.blobUrl,
            tx,
          );
          if (stillReferenced) {
            reason = 'sweep_referenced';
          } else if (deletedBlobKeys.has(image.blobKey)) {
            // An earlier row of THIS batch already reclaimed these bytes.
            reason = orphan ? 'sweep_orphaned' : 'sweep';
          } else {
            // A throw here propagates: the row stays for the next tick.
            await deps.storage.delete(image.blobKey);
            blobDeleted = true;
          }
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
            reason,
            actor_role: 'system',
          },
        });
        return blobDeleted;
      });
      rowsRemoved += 1;
      if (outcome) {
        deletedBlobKeys.add(image.blobKey);
        blobsDeleted += 1;
      }
    } catch (e) {
      logger.warn(
        { err: errKind(e), tenantId: input.tenantId, imageId: image.id, orphan, requestId: input.requestId },
        'broadcasts.image_sweep.row_retry_next_tick',
      );
    }
  }
  return ok({ scanned: batch.length, blobsDeleted, rowsRemoved });
}
