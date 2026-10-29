/**
 * A `/send` Resend refused NON-retryably — did it really not go out? Shared by
 * both dispatch legs (`dispatchScheduledBroadcast`, `buildAudienceTick`).
 *
 * MEASURED 2026-10-29 (live Broadcasts account, sink address only): one
 * broadcast sent four times — `/send` with key K → 200; again with K, with a
 * different key, and with none → each `422 validation_error "Only draft
 * broadcasts can be sent or scheduled"`; the broadcast went queued → sent by
 * 40 s and exactly ONE email was delivered. So Resend itself refuses a second
 * send of any non-draft broadcast, whatever the idempotency key — and
 * `classifyResendError` reads that 422 as `permanent`. Without this probe a
 * `withRetry` replay after a lost response, or two overlapping senders on one
 * inherited draft, recorded `failed_to_dispatch`, told the member it did not go
 * out and released the quota slot — for mail that was delivered. (A `409`
 * never comes back for this, which is why each leg's 409 replay arm is all but
 * unreachable.)
 *
 * The verdict, a POSITIVE test as on every probe in this module:
 *   - `accepted` — `queued` / `sending` / `sent`: the mail is out; the caller
 *     advances the row exactly as its replay arm does.
 *   - `refused` — `draft`, or `cancelled` (a scheduled send Resend cancelled):
 *     genuinely never sent — the reading the inherited-id probe (legacy Step
 *     1b) gives both; the caller's ordinary permanent handling stands.
 *   - `unverifiable` — anything else (`not_found`, `unknown`) or
 *     the probe itself failed: FAIL CLOSED — the caller refuses
 *     non-terminally (no terminal write, no FR-021 clock, nobody told).
 *
 * An `AuditPortInvariantError` (a wiring bug) still throws.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { AuditPortInvariantError } from '../ports/audit-port';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';

export type RefusedSendVerdict =
  | { readonly kind: 'accepted'; readonly status: 'queued' | 'sending' | 'sent' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'unverifiable' };

export async function probeRefusedSend(
  gateway: Pick<BroadcastsGatewayPort, 'retrieveBroadcast'>,
  ids: { readonly tenantId: string; readonly broadcastId: string; readonly resendBroadcastId: string },
  logPrefix: 'broadcasts.dispatch' | 'broadcasts.audience_import',
): Promise<RefusedSendVerdict> {
  let status: string;
  try {
    const probe = await gateway.retrieveBroadcast(ids.resendBroadcastId);
    status = probe.kind === 'present' ? probe.resource.status : 'not_found';
  } catch (e) {
    if (e instanceof AuditPortInvariantError) throw e;
    logger.error({ ...ids, err: errKind(e), severity: 'critical' }, `${logPrefix}.send_refusal_unverifiable`);
    return { kind: 'unverifiable' };
  }
  if (status === 'queued' || status === 'sending' || status === 'sent') {
    logger.warn({ ...ids, observedResendStatus: status }, `${logPrefix}.send_already_accepted`);
    return { kind: 'accepted', status };
  }
  if (status === 'draft' || status === 'cancelled') return { kind: 'refused' };
  logger.error({ ...ids, observedResendStatus: status, severity: 'critical' }, `${logPrefix}.send_refusal_unverifiable`);
  return { kind: 'unverifiable' };
}
