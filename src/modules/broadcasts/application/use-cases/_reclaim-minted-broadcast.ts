/**
 * Reclaim a Resend broadcast resource THIS TICK minted and cannot keep — shared
 * by both dispatch legs (`dispatchScheduledBroadcast`, `buildAudienceTick`).
 *
 * Called when the pre-send persist refuses the id
 * (`_persist-minted-broadcast-id.ts`): the resource we just minted is then
 * referenced by nothing and must be deleted while its id is still in hand.
 *
 * 2026-09-10 follow-ups (2) + (6). Best-effort, and the grade is decided by
 * whether the reclaim worked — on every arm alike: reclaimed → info; reclaim
 * failed → error at critical, because that is the one an operator has to act
 * on (the resource exists at Resend, no row references it, and no cron will
 * find it — `cleanup-orphaned-audiences` deletes audiences, not broadcasts).
 *
 * The tick's outcome is decided BEFORE this runs; nothing here changes the
 * return. And per the port docblock: never on an id read from the row.
 *
 * `logPrefix` keeps each leg's log namespace (`broadcasts.dispatch.*` /
 * `broadcasts.audience_import.*`), which the runbooks and alerts read.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';

export async function reclaimMintedBroadcast(
  deps: {
    readonly tenant: TenantContext;
    readonly broadcastsGateway: Pick<BroadcastsGatewayPort, 'deleteBroadcast'>;
  },
  input: { readonly broadcastId: BroadcastId },
  resendBroadcastId: string,
  resendAudienceId: string,
  ctx: {
    readonly why: 'attach_lost' | 'row_vanished' | 'persist_failed';
    readonly observedStatus?: string;
    readonly logPrefix: 'broadcasts.dispatch' | 'broadcasts.audience_import';
  },
): Promise<void> {
  try {
    await deps.broadcastsGateway.deleteBroadcast(resendBroadcastId);
    logger.info(
      {
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        resendBroadcastId,
        resendAudienceId,
        why: ctx.why,
        ...(ctx.observedStatus === undefined ? {} : { observedStatus: ctx.observedStatus }),
      },
      `${ctx.logPrefix}.minted_broadcast_reclaimed`,
    );
  } catch (reclaimErr) {
    logger.error(
      {
        err: errKind(reclaimErr),
        tenantId: deps.tenant.slug,
        broadcastId: input.broadcastId as string,
        leakedResendBroadcastId: resendBroadcastId,
        resendAudienceId,
        why: ctx.why,
        ...(ctx.observedStatus === undefined ? {} : { observedStatus: ctx.observedStatus }),
        severity: 'critical',
      },
      `${ctx.logPrefix}.minted_broadcast_leaked`,
    );
  }
}
