/**
 * Spec 139 review round 2 (code-review #3 + #9) — ONE re-read for a dispatch
 * tick that lost a race: "re-read the row; if it left `approved`, that is a
 * concurrent skip at info level, not a failure". Four copies of it lived in
 * the two legs:
 *
 *   - the legacy erased refusal whose terminal CAS lost (`erasedRefusalLostRace`);
 *   - the legacy `/send` 404 after the row left `approved` (P8);
 *   - the import leg's `failTerminally` concurrent-loss skip (CR#4);
 *   - the import leg's `sendLostToHold` (P8, and the hold's double race).
 *
 * The read now takes the row lock (`lockForUpdate`) inside a short tx of its
 * own, so it WAITS for an erasure cascade that is still deciding the row under
 * that lock (≈ 23 s at most, D-039) instead of reading `approved` from under it
 * and taking the error path. Each copy's own semantics are parameters:
 *
 *   - `stillOurs` — the row is as this tick left it (default: still
 *     `approved`; `sendLostToHold` also checks the import and broadcast ids);
 *   - `vanishedRowIsSkip` — a row that is gone is a skip too
 *     (`sendLostToHold` only; the others fall through);
 *   - `reportObservedStatus` — the `observedStatus` the skip answers: the
 *     status read (default), or `sendLostToHold`'s fixed token.
 *
 * `null` = not a skip (the row is still ours, gone where that is not a skip,
 * or the read failed): the caller takes its own path, exactly as before. Only
 * the halted / terminated refusals are NOT routed here (CR2#8, deferred).
 *
 * Call it with no tx open: it opens its own. Pure Application — ports only.
 */
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import type { TenantSlug } from '@/modules/tenants';
import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';

export interface LostRaceRereadOptions {
  /** Ids only, for both log lines (`tenantId`, `broadcastId`, …). */
  readonly logFields: Readonly<Record<string, unknown>>;
  /** The warn line when the re-read itself fails. */
  readonly readFailedEvent: string;
  /** The info line when the row has left us (a concurrent skip). */
  readonly skipEvent: string;
  /** The row is as this tick left it, so this is NOT a skip. Default: still `approved`. */
  readonly stillOurs?: (row: Broadcast) => boolean;
  /** A row that is gone is a skip too. Default: `false` (the caller's own path). */
  readonly vanishedRowIsSkip?: boolean;
  /** The `observedStatus` the skip answers. Default: the status read. */
  readonly reportObservedStatus?: 'read' | 'unknown_or_already_processed';
}

export interface LostRaceSkip {
  readonly kind: 'broadcast_invalid_state_transition';
  readonly observedStatus: string;
}

export async function rereadAfterLostRace(
  repo: Pick<BroadcastsRepo, 'withTx' | 'lockForUpdate' | 'findByIdInTx'>,
  tenantSlug: TenantSlug,
  broadcastId: BroadcastId,
  opts: LostRaceRereadOptions,
): Promise<LostRaceSkip | null> {
  let row: Broadcast | null;
  try {
    row = await repo.withTx(async (tx) => {
      await repo.lockForUpdate(tx, tenantSlug, broadcastId);
      return repo.findByIdInTx(tx, tenantSlug, broadcastId);
    });
  } catch (readErr) {
    logger.warn({ ...opts.logFields, err: errKind(readErr) }, opts.readFailedEvent);
    return null;
  }
  const stillOurs = opts.stillOurs ?? ((r: Broadcast) => r.status === 'approved');
  if (row === null ? opts.vanishedRowIsSkip !== true : stillOurs(row)) return null;
  logger.info({ ...opts.logFields, observedStatus: row?.status ?? null }, opts.skipEvent);
  return {
    kind: 'broadcast_invalid_state_transition',
    observedStatus:
      opts.reportObservedStatus === 'unknown_or_already_processed' || row === null
        ? 'unknown_or_already_processed'
        : row.status,
  };
}
