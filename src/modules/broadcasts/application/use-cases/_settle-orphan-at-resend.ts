/**
 * Spec 140 s2c (DL6, DL10) — ask Resend what became of one orphaned id, the
 * ONE outcome table the `cleanup-audiences` drain and the erasure cascade share
 * (plan.md § Slice 2c, items 5 and 6):
 *
 *   | resource  | call(s)                                   | outcome        |
 *   | broadcast | none: a sent row holds the id             | `superseded`   |
 *   | broadcast | DELETE deleted                            | `deleted`      |
 *   | broadcast | DELETE absent, pause, GET not_found       | `absent`       |
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
 *
 * Review round 2:
 * - code-review #2 — a broadcast orphan whose id a sent row holds
 *   (`heldBySentRow`) is an ordinary delivery: `superseded`, no Resend call;
 * - code-review #4 — a DELETE 404 settles `absent` only once a GET, sent
 *   `REPROBE_PAUSE_MS` later, answers `not_found` too (the import leg's "two
 *   not-founds" rule, `_reprobe-pause.ts`); any other GET leaves the row.
 *
 * Never throws; `undecided` carries a closed token for the log line, never the
 * provider's text.
 *
 * Pure Application — no framework imports.
 */
import type { OrphanOutcome } from '../../domain/value-objects/orphaned-resend-id';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { OrphanedResendIdRef } from '../ports/broadcast-orphans-repo';
import { classifyResendDraftAnswer } from './_classify-resend-draft-answer';
import { classifyThrown } from './_classify-thrown';
import { REPROBE_PAUSE_MS, sleepBeforeReprobe } from './_reprobe-pause';

export type OrphanSettlement =
  | { readonly kind: 'settled'; readonly outcome: OrphanOutcome }
  | { readonly kind: 'undecided'; readonly answer: string };

export async function settleOrphanAtResend(
  gateway: Pick<BroadcastsGatewayPort, 'deleteBroadcastOnce' | 'retrieveBroadcastOnce' | 'deleteAudience'>,
  orphan: Pick<OrphanedResendIdRef, 'resourceType' | 'resourceId' | 'heldBySentRow'>,
  pauseBeforeReprobe: (ms: number) => Promise<void> = sleepBeforeReprobe,
): Promise<OrphanSettlement> {
  try {
    if (orphan.resourceType === 'audience') {
      await gateway.deleteAudience(orphan.resourceId);
      return { kind: 'settled', outcome: 'deleted' };
    }
    if (orphan.heldBySentRow) return { kind: 'settled', outcome: 'superseded' };
    const deleted = await gateway.deleteBroadcastOnce(orphan.resourceId);
    // Spec 140 s2d (#735) — the table is `classifyResendDraftAnswer`'s `orphan` policy.
    const first = classifyResendDraftAnswer('orphan', deleted.kind, null);
    if (first.kind === 'deleted') return { kind: 'settled', outcome: 'deleted' };
    if (first.kind === 'undecided') return { kind: 'undecided', answer: first.deleted };
    // A 404 is confirmed by a GET `REPROBE_PAUSE_MS` later; a 403 is probed at once.
    if (first.pause) await pauseBeforeReprobe(REPROBE_PAUSE_MS);
    const probe = await gateway.retrieveBroadcastOnce(orphan.resourceId);
    const answer = classifyResendDraftAnswer('orphan', first.deleted, probe);
    if (answer.kind === 'undecided') return { kind: 'undecided', answer: `${answer.deleted}_probe_${answer.probed}` };
    if (answer.kind === 'absent') return { kind: 'settled', outcome: 'absent' };
    if (answer.kind === 'handed') return { kind: 'settled', outcome: 'handed' };
    return { kind: 'settled', outcome: 'retained' };
  } catch (e) {
    return { kind: 'undecided', answer: `threw_${classifyThrown(e).kind}` };
  }
}
