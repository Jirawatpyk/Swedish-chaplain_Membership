/**
 * Persist a Resend broadcast id BEFORE the send — `buildAudienceTick`'s S8
 * block. It was shared with the legacy leg's F4 block (the two carried the same
 * ~100 lines each until code review #8, 2026-10-29) until spec 140 s4 deleted
 * that leg.
 *
 * The write is `attachBroadcastId`, in its OWN tx and its own try/catch: it
 * must commit independently of the later status flip, and its CAS refusals are
 * repo faults, not gateway faults (a gateway catch around it once deleted the
 * winner's live audience, on the legacy leg's Step-3 catch).
 *
 * `null` = landed, send it. Anything else is the tick's answer, and on every
 * one of them NOTHING is sent:
 *
 * - `BroadcastConcurrentMutationError` — a sibling tick attached its own id
 *   first, the row left `approved` since Step 1 (withdrawn, cancelled,
 *   re-opened) or — import leg — a hold claimed it (the fence). A MINTED
 *   resource is reclaimed: the CAS refused OUR id, so it is orphaned by
 *   construction.
 * - `BroadcastNotFoundError` — the row is gone; reclaim a minted resource. No
 *   code path in `src/` produces it today (defence in depth): routing a
 *   vanished row into the DB-fault arm would page at critical for a row that
 *   can never be retried.
 * - Anything else — a DB fault, BEFORE any mail went out, so the safe answer
 *   is the transient one (`persist_broadcast_id` — NOT budgeted by FR-021:
 *   round 4 F3 removed DB-fault budgeting). For a minted id the
 *   throw cannot say whether the write landed (a commit whose ack was lost on
 *   the pooler looks identical), so the row is read back first: landed → KEEP
 *   the resource (the next tick inherits and probes it — deleting it would make
 *   that tick probe `not_found` and fail the broadcast); absent → reclaim;
 *   read-back failed → keep (a junk draft in the dashboard is the cheaper
 *   wrong).
 *
 * `minted: false` (import leg only) — an INHERITED id re-asserted through the
 * fence. It was on the row before this write and it is not this tick's to
 * delete on ANY arm (a hold that won owns its removal), so there is no reclaim
 * and nothing to read back.
 *
 * Spec 140 s2c (DL6) — a minted id left on no row is RECORDED
 * (`broadcast_orphaned_resend_ids`, best-effort, `recordOrphanBestEffort`) so
 * the `cleanup-audiences` drain deletes it at Resend: a reclaim that leaked
 * (`attach_lost` / `row_vanished` / `persist_failed`), and a DB fault whose
 * read-back failed and kept the id (`read_back_failed_kept` — the id may be on
 * the row after all; the drain skips it while a non-terminal row holds it). A
 * reclaimed id, a landed id and an inherited id are not recorded.
 *
 * `logPrefix` keeps the caller's log namespace (`broadcasts.audience_import.*`
 * since spec 140 s4; `broadcasts.dispatch.*` was the legacy leg's); `logFields`
 * adds the caller's extra ids (`importId`).
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastOrphansRepo } from '../ports/broadcast-orphans-repo';
import type { BroadcastsRepo, LeaseToken } from '../ports/broadcasts-repo';
import { BroadcastConcurrentMutationError, BroadcastNotFoundError } from '../ports/broadcasts-repo';
import { reclaimMintedBroadcast } from './_reclaim-minted-broadcast';
import { recordOrphanBestEffort } from './_record-orphaned-resend-id';

/** The three refusals, in the shape the tick's error union already carries. */
export type PersistBroadcastIdRefusal =
  | { readonly kind: 'broadcast_invalid_state_transition'; readonly observedStatus: string }
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: string }
  | {
      readonly kind: 'dispatch.server_error';
      readonly message: 'duplicate_resend_broadcast_id' | 'attach_broadcast_id_failed';
      readonly errClass: string;
      readonly phase: 'persist_broadcast_id';
    };

export async function persistBroadcastIdBeforeSend(
  deps: {
    readonly tenant: TenantContext;
    readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx' | 'attachBroadcastId' | 'findById'>;
    readonly broadcastsGateway: Pick<BroadcastsGatewayPort, 'deleteBroadcast'>;
    /** Spec 140 s2c — where a minted id left on no row is recorded. */
    readonly orphans: Pick<BroadcastOrphansRepo, 'recordOrphanedResendId'>;
  },
  input: { readonly broadcastId: BroadcastId },
  args: {
    readonly resendBroadcastId: string;
    /** Spec 140 s2c [A7] — the row's requester, stored on an orphan row (a snapshot, no FK). */
    readonly requestedByMemberId: string;
    /** Logged by the reclaim only. */
    readonly resendAudienceId: string;
    readonly minted: boolean;
    /**
     * Spec 140 s2b — the import tick's lease token (`null`: a non-holder).
     * A lost token is a `BroadcastConcurrentMutationError` (`lease_lost`), so it
     * takes the concurrent arm below: a minted id is reclaimed. That reclaim is
     * deliberately NOT lease-checked (A2): the id is on no row, so no other
     * tick can be sending it, and a check would always fail at the very moment
     * the lease is lost — leaking the draft.
     */
    readonly lease: LeaseToken | null;
    readonly fence?: { readonly expectedAudienceImportId: string; readonly replacesResendBroadcastId?: string };
    readonly logPrefix: 'broadcasts.dispatch' | 'broadcasts.audience_import';
    readonly logFields?: Readonly<Record<string, unknown>>;
  },
): Promise<PersistBroadcastIdRefusal | null> {
  const { resendBroadcastId, logPrefix } = args;
  try {
    await deps.broadcastsRepo.withTx(async (tx) => {
      await deps.broadcastsRepo.attachBroadcastId(
        tx,
        deps.tenant.slug,
        input.broadcastId,
        resendBroadcastId,
        args.lease,
        ...(args.fence === undefined ? [] : [args.fence]),
      );
    });
    return null;
  } catch (persistErr) {
    const ids = {
      tenantId: deps.tenant.slug,
      broadcastId: input.broadcastId as string,
      resendBroadcastId,
      ...args.logFields,
    };
    const recordOrphan = (reason: 'attach_lost' | 'row_vanished' | 'persist_failed' | 'read_back_failed_kept') =>
      recordOrphanBestEffort(deps.orphans, { tenantId: deps.tenant.slug, logPrefix }, {
        broadcastId: input.broadcastId,
        requestedByMemberId: args.requestedByMemberId,
        resourceType: 'broadcast',
        resourceId: resendBroadcastId,
        reason,
      });
    const reclaim = async (why: 'attach_lost' | 'row_vanished' | 'persist_failed', observedStatus?: string) => {
      if (!args.minted) return;
      const reclaimed = await reclaimMintedBroadcast(deps, input, resendBroadcastId, args.resendAudienceId, {
        why,
        logPrefix,
        ...(observedStatus === undefined ? {} : { observedStatus }),
      });
      if (reclaimed === 'leaked') await recordOrphan(why);
    };
    if (persistErr instanceof BroadcastConcurrentMutationError) {
      if (!args.minted) logger.info(ids, `${logPrefix}.send_fence_lost`);
      await reclaim('attach_lost', persistErr.observedStatus);
      return { kind: 'broadcast_invalid_state_transition', observedStatus: persistErr.observedStatus };
    }
    if (persistErr instanceof BroadcastNotFoundError) {
      await reclaim('row_vanished');
      return { kind: 'broadcast_not_found', broadcastId: input.broadcastId as string };
    }
    // Needs Resend to reissue an id, so a 23505 is the least likely member of
    // this class — but the one an operator cannot otherwise name.
    const persistFailureKind =
      (persistErr as { code?: string } | null)?.code === '23505'
        ? 'duplicate_resend_broadcast_id'
        : 'attach_broadcast_id_failed';
    logger.error(
      {
        ...ids,
        err: errKind(persistErr),
        // NOT `reason` — that key is in `REDACT_PATHS`, so the token added so
        // an operator could name a 23505 printed `[REDACTED]`.
        persistFailureKind,
        severity: 'critical',
      },
      `${logPrefix}.attach_broadcast_id_failed`,
    );
    if (args.minted) {
      let idLanded: boolean | null = null;
      try {
        const readBack = await deps.broadcastsRepo.findById(deps.tenant.slug, input.broadcastId);
        idLanded = readBack?.resendBroadcastId === resendBroadcastId;
      } catch (readErr) {
        logger.warn({ err: errKind(readErr), ...ids }, `${logPrefix}.persist_read_back_failed_resource_kept`);
      }
      if (idLanded === false) {
        await reclaim('persist_failed');
      } else if (idLanded === true) {
        logger.warn(ids, `${logPrefix}.persist_ack_lost_id_kept`);
      } else {
        await recordOrphan('read_back_failed_kept');
      }
    }
    return {
      kind: 'dispatch.server_error',
      message: persistFailureKind,
      errClass: errKind(persistErr),
      phase: 'persist_broadcast_id',
    };
  }
}
