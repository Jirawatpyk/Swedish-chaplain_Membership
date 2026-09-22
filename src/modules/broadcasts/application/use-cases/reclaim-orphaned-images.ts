/**
 * F119 T035 — `reclaimOrphanedImages`: the daily image-blob sweep
 * (data-model § 4; spec § Personal data).
 *
 * ROUND-3 #15 — the guarantee is "on the NEXT DAILY TICK, 200 rows per arm
 * per tenant", not "within 24 hours". The two differ whenever a tenant has
 * more than 400 reclaimable rows in a day — a bulk erasure, a prune of a
 * backlog of drafts — and they differ again for a row that throws, which is
 * left for the tick after. Saying 24 hours states a ceiling nothing enforces.
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
 * RETAINED (ROUND-2 S-3). When live content DOES still embed the URL, the row
 * is NOT removed — it is un-stamped back into the live set. Removing it made
 * the image reachable by nothing afterwards: the marked arm has nothing to
 * stamp, the orphan arm has nothing to anti-join, and the Art. 17 / §33
 * erasure cascade stamps rows, so the blob kept being served with no handle
 * left on it. A retained row emits NO audit (nothing was removed — an audit
 * row saying otherwise is the audit-truth class this repo guards elsewhere);
 * the durable signal is `broadcasts_image_sweep_retained_total{tenant}` plus
 * `broadcasts.image_sweep.retained_still_referenced`. Retained ORPHAN rows are
 * re-examined every tick, which is the point — they stay reachable — but a
 * climbing `retained` count means they are eating into the bounded batch.
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
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantSlug } from '@/modules/tenants';
import type { AuditPort } from '../ports/audit-port';
import type { BroadcastImageRecord, BroadcastImagesRepo } from '../ports/broadcast-images-repo';
import type { ImageStoragePort } from '../ports/image-storage-port';

export const IMAGE_SWEEP_BATCH = 200;

/**
 * ROUND-3 #4 — the per-row transaction's `SET LOCAL statement_timeout`, which
 * T035 requires ("its own `SET LOCAL statement_timeout`") and which nothing
 * set until now.
 *
 * Neither of the two waits inside that transaction ends on its own. The
 * advisory lock blocks until its holder commits, and
 * `isBlobReferencedByContent` is a sequential `position()` scan of
 * `broadcasts` + `broadcast_templates` executed once per swept row — up to 400
 * a tick. `src/lib/db.ts` asks the connection for 5 s, but the pooled Neon
 * endpoint drops it and reports 0, so the real ceiling today is the route's
 * `maxDuration = 300`: the tick is killed part way through, with the blob
 * store and `broadcast_images` disagreeing until tomorrow.
 *
 * 5 s because neither T035 nor the cron's docblock names a value. The sibling
 * metric routes use 10 s, but they bound a whole gauge sweep; this bounds ONE
 * row's three small statements, so the tighter number is the honest one. A row
 * that hits it throws, is logged, and is retried on the next tick — the same
 * path any other per-row fault takes.
 */
export const IMAGE_SWEEP_ROW_TIMEOUT_MS = 5_000;

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
  /**
   * ROUND-2 S-3 — rows the sweep KEPT (and un-stamped) because live content
   * still embeds their blob URL. `scanned = rowsRemoved + retained + rows that
   * threw`; a row is never both.
   */
  readonly retained: number;
}

export type ReclaimOrphanedImagesError = {
  readonly kind: 'sweep.server_error';
  readonly message: string;
};

/**
 * Why this row was reaped — the audit's `reason`, one per arm.
 *
 * ROUND-2 S-3 removed `'sweep_referenced'`: that case no longer reaps
 * anything, so it emits no audit row at all (see `RowOutcome`).
 */
type SweepReason = 'sweep' | 'sweep_orphaned';

/**
 * What one per-row transaction did. `'retained'` is ROUND-2 S-3: the bytes
 * AND the row stayed, and the row went back in the live set.
 *
 * Accountability note (DPO decision, 2026-09-22 — option A, the last-reference
 * rule): when the retained row was stamped by an ERASURE, the audit trail ends
 * at `broadcast_image_removed { reason: 'member_erased' }` with no
 * counter-event, while the row is live again and the bytes are still served.
 * That silence is deliberate — nothing was removed, and a row saying otherwise
 * would be the audit-truth class this repo guards. The evidence for a DSR
 * answer is therefore the STATE, not the trail:
 * `docs/runbooks/member-erasure.md` § Verifying step 4 enumerates exactly which
 * of the subject's images survived and which live content holds each, and the
 * RoPA (§ F119 Erasure row) requires that count — including zero — on the
 * ticket. Change this arm and those two documents change with it.
 */
type RowOutcome = 'removed_blob_deleted' | 'removed_blob_kept' | 'retained';

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
  let retained = 0;

  for (const { image, orphan } of batch) {
    try {
      const outcome = await deps.imagesRepo.withTx(input.tenantId, async (tx): Promise<RowOutcome> => {
        // ROUND-3 #4 — FIRST, before anything that can block. The lock waits
        // on whoever holds it and the content scan is sequential; a bound set
        // after the statement it is meant to bound is not a bound.
        await deps.imagesRepo.setStatementTimeout(IMAGE_SWEEP_ROW_TIMEOUT_MS, tx);

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
        const reason: SweepReason = orphan ? 'sweep_orphaned' : 'sweep';
        if (live === 0) {
          // F2-10(b) — pre-0304 blobs have no row but ARE referenced by live
          // `body_html`.
          const stillReferenced = await deps.imagesRepo.isBlobReferencedByContent(
            input.tenantId,
            image.blobUrl,
            tx,
          );
          if (stillReferenced) {
            // ROUND-2 S-3 (PDPA reach) — keep the bytes AND the row. Removing
            // the row here made the image reachable by nothing afterwards: the
            // marked arm has nothing to stamp, the orphan arm has nothing to
            // anti-join, and the Art. 17 / §33 erasure cascade stamps rows. The
            // blob went on being served with no handle left on it.
            //
            // So the row goes back in the LIVE set instead. That is the honest
            // state: live content still embeds this URL, so its reference is
            // not gone. When that content goes, the next tick's orphan arm (or
            // a fresh erasure stamp) reaches it again.
            //
            // No `broadcast_image_removed` audit — nothing was removed, and an
            // audit row claiming otherwise is exactly the audit-truth class
            // this repo already guards elsewhere. The durable signal is the
            // metric plus this log line.
            await deps.imagesRepo.restoreLive(input.tenantId, image.id, tx);
            return 'retained';
          } else if (deletedBlobKeys.has(image.blobKey)) {
            // An earlier row of THIS batch already reclaimed these bytes.
            // Nothing to do: `blobDeleted` stays false so the count is honest.
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
        return blobDeleted ? 'removed_blob_deleted' : 'removed_blob_kept';
      });
      if (outcome === 'retained') {
        retained += 1;
        broadcastsMetrics.imageSweepRetained(input.tenantId as unknown as string);
        logger.info(
          {
            tenantId: input.tenantId,
            imageId: image.id,
            contentHash: image.contentHash,
            orphan,
            requestId: input.requestId,
          },
          'broadcasts.image_sweep.retained_still_referenced',
        );
        continue;
      }
      rowsRemoved += 1;
      if (outcome === 'removed_blob_deleted') {
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
  return ok({ scanned: batch.length, blobsDeleted, rowsRemoved, retained });
}
