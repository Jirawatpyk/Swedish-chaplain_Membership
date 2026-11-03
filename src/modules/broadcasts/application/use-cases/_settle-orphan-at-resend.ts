/**
 * Spec 140 s2c (DL6, DL10) — ask Resend what became of one orphaned id, the
 * ONE outcome table the `cleanup-audiences` drain and the erasure cascade share
 * (plan.md § Slice 2c, items 5 and 6):
 *
 *   | resource  | call(s)                                   | outcome        |
 *   | broadcast | DELETE deleted / absent                   | same           |
 *   | broadcast | DELETE forbidden, GET canceled / failed   | `retained`     |
 *   | broadcast | DELETE forbidden, GET queued/sending/sent | `handed`       |
 *   | broadcast | anything else (a throw included)          | undecided      |
 *   | audience  | `deleteAudience` resolves (404 / 410 too) | `deleted`      |
 *   | audience  | it throws                                 | undecided      |
 *
 * The broadcast calls are the bounded single-attempt `*Once` pair
 * (`RESEND_CALL_TIMEOUT_MS` each). DELETE answers 200 only on a draft or a
 * scheduled broadcast (MEASURED 2026-10-29), so a copy a tick is sending
 * cannot be deleted from under it: it answers 403 and the GET reads it handed.
 * Never throws; `undecided` carries a closed token for the log line, never the
 * provider's text.
 *
 * Pure Application — no framework imports.
 */
import type { OrphanOutcome } from '../../domain/value-objects/orphaned-resend-id';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { OrphanedResendIdRef } from '../ports/broadcast-orphans-repo';
import { classifyThrown } from './_classify-thrown';
import { isHandedStatus } from './_probe-refused-send';

export type OrphanSettlement =
  | { readonly kind: 'settled'; readonly outcome: OrphanOutcome }
  | { readonly kind: 'undecided'; readonly answer: string };

export async function settleOrphanAtResend(
  gateway: Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce' | 'retrieveBroadcastOnce' | 'deleteAudience'>,
  orphan: Pick<OrphanedResendIdRef, 'resourceType' | 'resourceId'>,
): Promise<OrphanSettlement> {
  try {
    if (orphan.resourceType === 'audience') {
      await gateway.deleteAudience(orphan.resourceId);
      return { kind: 'settled', outcome: 'deleted' };
    }
    const deleted = await gateway.deleteBroadcastOnce(orphan.resourceId);
    if (deleted.kind === 'deleted' || deleted.kind === 'absent') return { kind: 'settled', outcome: deleted.kind };
    if (deleted.kind !== 'forbidden') return { kind: 'undecided', answer: deleted.kind };
    const probe = await gateway.retrieveBroadcastOnce(orphan.resourceId);
    const probed = probe.kind === 'present' ? probe.status : probe.kind;
    if (isHandedStatus(probed)) return { kind: 'settled', outcome: 'handed' };
    if (probed === 'cancelled' || probed === 'failed') return { kind: 'settled', outcome: 'retained' };
    return { kind: 'undecided', answer: `forbidden_probe_${probed}` };
  } catch (e) {
    return { kind: 'undecided', answer: `threw_${classifyThrown(e).kind}` };
  }
}
