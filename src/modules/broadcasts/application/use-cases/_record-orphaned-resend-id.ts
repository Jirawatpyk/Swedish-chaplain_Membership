/**
 * Spec 140 s2c — write one orphan row, best-effort (plan.md § Slice 2c, item 2).
 *
 * Every writer calls this at the CALLER that holds the id and the requester,
 * after its outcome is decided: the record never changes what a tick answers.
 * The insert runs in its own transaction (`recordOrphanedResendId`), so it
 * commits whatever the tick does next.
 *
 * [P M-3] A failed insert is the residual an operator must act on by hand (the
 * id is now on no row AND in no table): one ERROR line at critical with the
 * ids and the closed reason token, never content. The key is `orphanReason`,
 * not `reason`: `reason` is in `logger.ts` REDACT_PATHS and prints `[REDACTED]`.
 */
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import type { BroadcastOrphansRepo, RecordOrphanInput } from '../ports/broadcast-orphans-repo';

export async function recordOrphanBestEffort(
  orphans: Pick<BroadcastOrphansRepo, 'recordOrphanedResendId'>,
  ctx: { readonly tenantId: string; readonly logPrefix: 'broadcasts.dispatch' | 'broadcasts.audience_import' },
  input: RecordOrphanInput,
): Promise<void> {
  const fields = {
    tenantId: ctx.tenantId,
    broadcastId: input.broadcastId as string,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    orphanReason: input.reason,
  };
  try {
    await orphans.recordOrphanedResendId(input);
    logger.info(fields, `${ctx.logPrefix}.orphan_recorded`);
  } catch (e) {
    // Review round 1 (pdpa L-B) — the requester (a uuid, no content), so the
    // by-hand fix this line asks for can tell whose erasure it may bear on.
    logger.error(
      { ...fields, requestedByMemberId: input.requestedByMemberId, err: errKind(e), severity: 'critical' },
      `${ctx.logPrefix}.orphan_record_failed`,
    );
  }
}
