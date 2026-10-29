/**
 * Persist a Resend broadcast id BEFORE the send — shared by both dispatch legs
 * (`dispatchScheduledBroadcast`'s F4 block, `buildAudienceTick`'s S8 block),
 * which carried the same ~100 lines each until code review #8 (2026-10-29).
 *
 * The write is `attachBroadcastId`, in its OWN tx and its own try/catch: it
 * must commit independently of the later status flip, and its CAS refusals are
 * repo faults, not gateway faults (a gateway catch around it once deleted the
 * winner's live audience — see the legacy leg's Step-3 catch).
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
 *   is the transient one (`persist_broadcast_id` — NOT budgeted by FR-021 on
 *   either leg: round 4 F3 removed DB-fault budgeting). For a minted id the
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
 * `logPrefix` keeps each leg's log namespace — the names below are unchanged
 * from the code they replace (`broadcasts.dispatch.*` is the LIVE leg's, read
 * by runbooks and alerts); `logFields` adds a leg's extra ids (the import leg's
 * `importId`). The returned error shapes are the ones both legs returned.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import { BroadcastConcurrentMutationError, BroadcastNotFoundError } from '../ports/broadcasts-repo';
import { reclaimMintedBroadcast } from './_reclaim-minted-broadcast';

/** The three refusals, in the shape both legs' error unions already carry. */
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
  },
  input: { readonly broadcastId: BroadcastId },
  args: {
    readonly resendBroadcastId: string;
    /** Logged by the reclaim only. */
    readonly resendAudienceId: string;
    readonly minted: boolean;
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
    const reclaim = async (why: 'attach_lost' | 'row_vanished' | 'persist_failed', observedStatus?: string) => {
      if (!args.minted) return;
      await reclaimMintedBroadcast(deps, input, resendBroadcastId, args.resendAudienceId, {
        why,
        logPrefix,
        ...(observedStatus === undefined ? {} : { observedStatus }),
      });
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
