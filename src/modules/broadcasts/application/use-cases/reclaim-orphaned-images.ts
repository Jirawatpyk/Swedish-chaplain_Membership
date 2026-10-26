/**
 * F119 T035 — `reclaimOrphanedImages`: the daily image-blob sweep
 * (data-model § 4; spec § Personal data).
 *
 * ROUND-3 #15 — the guarantee is "on the NEXT DAILY TICK, 200 rows per arm
 * per tenant", not "within 24 hours". The two differ whenever a tenant has
 * more than 600 reclaimable rows in a day — a bulk erasure, a prune of a
 * backlog of drafts — and they differ again for a row that throws, which is
 * left for the tick after. Saying 24 hours states a ceiling nothing enforces.
 *
 * THREE ARMS.
 *
 * 1. MARKED (`deleted_at IS NOT NULL`) — the primary mechanism. A row is
 *    stamped inside the same transaction as the state change that removed
 *    the reference: a member erasure, a draft discard, the draft prune, a
 *    withdrawal or cancel, a rejection, the retention sweep, and (spec 131)
 *    the author's release of an image they uploaded and left out
 *    (`not_inserted`). The reasons are `ImageRemovalReason`.
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
 * 3. UNUSED (`deleted_at IS NULL`, spec 131) — a live image of an E-Blast
 *    that can no longer change (terminal status) and whose own content does
 *    not use it (`listUnused`). Before this arm, an image uploaded and left
 *    out of a SENT E-Blast stayed at its public URL until the retention sweep,
 *    about five years later. The owner check is in the SELECT, so an image the
 *    E-Blast shows is never in the batch; the tenant-wide content backstop
 *    below still applies, so content elsewhere that embeds it keeps it.
 *
 * THE LAST-REFERENCE RULE. A blob is deleted iff no LIVE row of EITHER
 * owner_kind shares its `content_hash` (a template image a draft uses is
 * kept) AND no live content still embeds the URL (F2-10(b) — the table was
 * not backfilled, so pre-0304 images are referenced by `body_html` with no
 * row to prove it). The row is then removed and `broadcast_image_removed` is
 * audited in the same tx, with a `blob_disposition` (F7-1) that states what
 * happened to the BYTES — see `BlobDisposition`.
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
 * Retained UNUSED rows (spec 131) are watermarked instead and re-examined when
 * the 30-day window lapses, so they cannot fill arm 3's batch.
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
 *
 * F7-1 — a row that throws is COUNTED (`rowsFailed`) and metered
 * (`broadcasts_image_sweep_row_failed_total{tenant}`). It used to be a `warn`
 * line only, so a persistent fault — an expired Blob token fails every row
 * every day — read as a clean tick while erased members' images stayed
 * publicly served.
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
 * `broadcasts`, `broadcast_versions` and `broadcast_templates` executed once per swept row — up to 600
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

/**
 * Spec 131 (#658 reviews) — the bound on each LISTING transaction. The lists
 * ran with none (the pooled endpoint drops the connect-time 5 s), so a slow
 * list could run until `maxDuration`. 20 s, not the row's 5 s: arm 3's
 * watermark UPDATE scans up to `UNUSED_MARK_BATCH` rows' content in one
 * statement, and the first tick after spec 131 meets the whole backlog.
 */
export const IMAGE_SWEEP_LIST_TIMEOUT_MS = 20_000;

/**
 * Spec 131 — arm 3 examines a row at most once per this window (0319
 * `unused_checked_at`). A terminal E-Blast's content never changes, so a row
 * its owner uses needs no re-scan sooner; a row the content backstop kept is
 * re-examined when the window lapses, automatically.
 */
export const UNUSED_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** Spec 131 — how many used rows one tick may watermark (one UPDATE). */
export const UNUSED_MARK_BATCH = 1_000;

export interface ReclaimOrphanedImagesDeps {
  readonly imagesRepo: BroadcastImagesRepo;
  readonly storage: Pick<ImageStoragePort, 'delete'>;
  readonly audit: AuditPort;
  /** Epoch ms, for the deadline. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

export interface ReclaimOrphanedImagesInput {
  readonly tenantId: TenantSlug;
  readonly now: Date;
  readonly requestId: string;
  /**
   * Spec 131 (#658 reliability M2) — epoch ms (on `deps.clock`) after which no
   * new row is started. The cron gives the block a share of its `maxDuration`,
   * so a large tick ends cleanly between rows instead of being killed inside
   * one, and the cron's later blocks still run. Omitted: no deadline.
   */
  readonly deadlineMs?: number;
}

export interface ReclaimOrphanedImagesOutput {
  readonly scanned: number;
  readonly blobsDeleted: number;
  readonly rowsRemoved: number;
  /**
   * ROUND-2 S-3 — rows the sweep KEPT (and un-stamped) because live content
   * still embeds their blob URL. `scanned = rowsRemoved + retained +
   * rowsFailed`; a row is in exactly one of the three.
   */
  readonly retained: number;
  /**
   * F7-1 — rows whose per-row transaction threw. Left for the next tick; the
   * cron logs a non-zero count at `error` and the counter carries the alert.
   */
  readonly rowsFailed: number;
  /** Spec 131 — the deadline stopped the batch; the rest waits for the next tick. */
  readonly truncated: boolean;
  /**
   * Spec 131 — arm 3's own listing failed. Arms 1 and 2 still ran: an erased
   * member's images must not wait on the newest arm.
   */
  readonly unusedListFailed: boolean;
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
type SweepReason = 'sweep' | 'sweep_orphaned' | 'sweep_unused';

/**
 * Which arm selected the row. ORPHANED and UNUSED rows are LIVE (only MARKED
 * rows are stamped), so those two must not count themselves as the holder of
 * their own bytes.
 */
type SweepArm = 'marked' | 'orphaned' | 'unused';

const REASON_BY_ARM: Readonly<Record<SweepArm, SweepReason>> = {
  marked: 'sweep',
  orphaned: 'sweep_orphaned',
  unused: 'sweep_unused',
};

/**
 * F7-1 (audit truth) — what happened to the BYTES of a REMOVED row. It is the
 * audit's `blob_disposition` and the source of its summary, so the summary can
 * never claim a different fact from the payload. `blob_deleted` stays in the
 * payload for existing readers and is true only for `'deleted'`.
 *
 * - `'deleted'` — this row deleted the blob.
 * - `'kept_shared_row'` — another LIVE image row (either `owner_kind`) shares
 *   the `content_hash`, so the bytes stay for that holder.
 * - `'reclaimed_by_sibling'` — an EARLIER row of this same batch, sharing the
 *   hash, already deleted the bytes. This case used to be audited "blob kept
 *   by reference" while the bytes were gone.
 */
type BlobDisposition = 'deleted' | 'kept_shared_row' | 'reclaimed_by_sibling';

const DISPOSITION_SUMMARY: Readonly<Record<BlobDisposition, string>> = {
  deleted: 'blob deleted',
  kept_shared_row: 'blob kept — another live image row shares its content',
  reclaimed_by_sibling: 'blob already deleted by an earlier row of this sweep',
};

/**
 * What one per-row transaction did: a removed row's `BlobDisposition`, or
 * `'retained'` (ROUND-2 S-3) — the bytes AND the row stayed, and the row went
 * back in the live set.
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
 *
 * Spec 131 — the UNUSED arm now re-examines such a row: the redacted owner is
 * terminal and no longer holds the URL, so `listUnused` picks it, the row is
 * watermarked while other content holds the file, looked at again when the
 * 30-day watermark lapses, and reclaimed once that content has gone. The
 * runbook step still surfaces it for the DSR answer while it is held.
 *
 * Decision (e), 2026-09-23 (conservative default; the DPO may revise): an
 * erased member's row removed as `'kept_shared_row'` also leaves bytes
 * served — identical bytes held by ANOTHER owner's live row — and counts as
 * still-served personal data of that member. Step 4 enumerates those too, and
 * the DSR ticket discloses their count, including zero.
 */
type RowOutcome = BlobDisposition | 'retained';

export async function reclaimOrphanedImages(
  deps: ReclaimOrphanedImagesDeps,
  input: ReclaimOrphanedImagesInput,
): Promise<Result<ReclaimOrphanedImagesOutput, ReclaimOrphanedImagesError>> {
  let marked: readonly BroadcastImageRecord[];
  let orphaned: readonly BroadcastImageRecord[];
  try {
    ({ marked, orphaned } = await deps.imagesRepo.withTx(input.tenantId, async (tx) => {
      await deps.imagesRepo.setStatementTimeout(IMAGE_SWEEP_LIST_TIMEOUT_MS, tx);
      return {
        marked: await deps.imagesRepo.listMarked(input.tenantId, IMAGE_SWEEP_BATCH, tx),
        orphaned: await deps.imagesRepo.listOrphaned(input.tenantId, IMAGE_SWEEP_BATCH, tx),
      };
    }));
  } catch (e) {
    return err({ kind: 'sweep.server_error', message: e instanceof Error ? e.message : String(e) });
  }

  // Spec 131 (#658 reviews) — arm 3 in its OWN bounded transaction, and its
  // failure isolated: the newest arm must never stop the marked arm, which
  // carries the erasure and release stamps. First the due rows their owner
  // uses are watermarked (no re-scan for 30 days), then the unused are listed.
  let unused: readonly BroadcastImageRecord[] = [];
  let unusedListFailed = false;
  const dueBefore = new Date(input.now.getTime() - UNUSED_RECHECK_MS);
  try {
    unused = await deps.imagesRepo.withTx(input.tenantId, async (tx) => {
      await deps.imagesRepo.setStatementTimeout(IMAGE_SWEEP_LIST_TIMEOUT_MS, tx);
      await deps.imagesRepo.markUsedImagesExamined(input.tenantId, input.now, dueBefore, UNUSED_MARK_BATCH, tx);
      return deps.imagesRepo.listUnused(input.tenantId, dueBefore, IMAGE_SWEEP_BATCH, tx);
    });
  } catch (e) {
    unusedListFailed = true;
    logger.error(
      { err: errKind(e), tenantId: input.tenantId, requestId: input.requestId },
      'broadcasts.image_sweep.unused_list_failed',
    );
  }

  const batch: Array<{ image: BroadcastImageRecord; arm: SweepArm }> = [
    ...marked.map((image) => ({ image, arm: 'marked' as const })),
    ...orphaned.map((image) => ({ image, arm: 'orphaned' as const })),
    ...unused.map((image) => ({ image, arm: 'unused' as const })),
  ];

  // F2-10 (LOW) — two rows of one batch can share a `content_hash`. Before
  // this set, the second row re-issued `storage.delete` on an already-deleted
  // key and counted a second deletion, so `blobsDeleted` over-reported and the
  // operator could not tell "two blobs reclaimed" from "one blob, two rows".
  const deletedBlobKeys = new Set<string>();
  let blobsDeleted = 0;
  let rowsRemoved = 0;
  let retained = 0;
  let rowsFailed = 0;
  let truncated = false;
  const clock = deps.clock ?? Date.now;

  for (const { image, arm } of batch) {
    if (input.deadlineMs !== undefined && clock() > input.deadlineMs) {
      truncated = true;
      break;
    }
    const live = arm !== 'marked';
    try {
      const outcome = await deps.imagesRepo.withTx(input.tenantId, async (tx): Promise<RowOutcome> => {
        // ROUND-3 #4 — FIRST, before anything that can block. The lock waits
        // on whoever holds it and the content scan is sequential; a bound set
        // after the statement it is meant to bound is not a bound.
        await deps.imagesRepo.setStatementTimeout(IMAGE_SWEEP_ROW_TIMEOUT_MS, tx);

        // F2-10(a) — BEFORE the count, so an upload of the same file cannot
        // land between the count and the delete.
        await deps.imagesRepo.lockContentHash(input.tenantId, image.contentHash, tx);

        // An ORPHANED or UNUSED row is itself live, so it must not count itself.
        const holders = await deps.imagesRepo.countLiveByContentHash(
          input.tenantId,
          image.contentHash,
          tx,
          live ? image.id : undefined,
        );

        let disposition: BlobDisposition = 'kept_shared_row';
        const reason = REASON_BY_ARM[arm];
        if (holders === 0) {
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
            // not gone. Whether anything reaches it again depends on its
            // OWNER. A draft-discard / prune row's owner is gone, so the next
            // tick's orphan arm re-examines it. An ERASURE-stamped row's owner
            // survives (erasure redacts the broadcast, it does not delete it),
            // so `listOrphaned` never selects it; since spec 131 the UNUSED
            // arm does (the redacted owner is terminal and no longer holds
            // the URL), at most every 30 days, and reclaims it once the
            // holding content goes. `docs/runbooks/member-erasure.md`
            // § Verifying step 4 surfaces it for the DSR answer meanwhile.
            //
            // No `broadcast_image_removed` audit — nothing was removed, and an
            // audit row claiming otherwise is exactly the audit-truth class
            // this repo already guards elsewhere. The durable signal is the
            // metric plus this log line.
            if (arm === 'unused') {
              // Spec 131 — already live; watermark it instead, or it is picked
              // again every tick and the batch fills with it (#658 reviews).
              await deps.imagesRepo.markUnusedExamined(input.tenantId, image.id, input.now, tx);
            } else {
              await deps.imagesRepo.restoreLive(input.tenantId, image.id, tx);
            }
            return 'retained';
          } else if (deletedBlobKeys.has(image.blobKey)) {
            // An earlier row of THIS batch already deleted these bytes. No
            // second delete, no second count — and the audit must say the
            // bytes are gone, not that they were kept (F7-1).
            disposition = 'reclaimed_by_sibling';
          } else {
            // A throw here propagates: the row stays for the next tick.
            await deps.storage.delete(image.blobKey);
            disposition = 'deleted';
          }
        }

        await deps.imagesRepo.remove(input.tenantId, image.id, tx);
        await deps.audit.emitTyped(tx, {
          eventType: 'broadcast_image_removed',
          tenantId: input.tenantId,
          requestId: input.requestId,
          actorUserId: 'system',
          summary: `E-Blast image swept (${DISPOSITION_SUMMARY[disposition]})`,
          payload: {
            related_member_id: null,
            owner_kind: image.ownerKind,
            owner_id: image.ownerId,
            image_id: image.id,
            content_hash: image.contentHash,
            blob_deleted: disposition === 'deleted',
            blob_disposition: disposition,
            reason,
            actor_role: 'system',
          },
        });
        return disposition;
      });
      if (outcome === 'retained') {
        retained += 1;
        broadcastsMetrics.imageSweepRetained(input.tenantId as unknown as string);
        logger.info(
          {
            tenantId: input.tenantId,
            imageId: image.id,
            contentHash: image.contentHash,
            arm,
            requestId: input.requestId,
          },
          'broadcasts.image_sweep.retained_still_referenced',
        );
        continue;
      }
      rowsRemoved += 1;
      if (outcome === 'deleted') {
        deletedBlobKeys.add(image.blobKey);
        blobsDeleted += 1;
      }
    } catch (e) {
      // F7-1 — counted and metered, not only logged: the cron reports
      // `rowsFailed` and the counter carries the alert.
      rowsFailed += 1;
      broadcastsMetrics.imageSweepRowFailed(input.tenantId as unknown as string);
      logger.warn(
        { err: errKind(e), tenantId: input.tenantId, imageId: image.id, arm, requestId: input.requestId },
        'broadcasts.image_sweep.row_retry_next_tick',
      );
    }
  }
  return ok({ scanned: batch.length, blobsDeleted, rowsRemoved, retained, rowsFailed, truncated, unusedListFailed });
}
