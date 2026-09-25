/**
 * #400 item 4 — what the outbox dispatcher does with a row it could not
 * render, and the reason it records (`last_error`, the `email_dispatch_failed`
 * audit payload, `outbox_permanent_failures_total{reason}`).
 *
 * Three shapes reach it from `buildPayload`:
 *   - a {@link PayloadMiss} — DETERMINISTIC: the thing the row refers to is gone
 *     (or, for `request_superseded`, the row is stale). Permanent on the FIRST
 *     tick, under the miss itself.
 *   - a {@link PayloadTransient} — a read threw this tick, for a reason the arm
 *     can NAME. Stays on the retry ladder under that reason, and ends under it
 *     after `MAX_ATTEMPTS`. Before #400 a failed read answered `null` and an
 *     exhausted row was closed as `no_template_handler` — "no template for
 *     this" — although the template existed and it was the read that failed.
 *   - `null` — no arm rendered it (an unknown type, a malformed context):
 *     retried, and closed as `no_template_handler`.
 *
 * Pure — no I/O, so the rule is unit-tested apart from the route's tx.
 */

/**
 * A deterministic miss. Per arm (the F114 arms and the F119 `eblast_*` arms do
 * not share one vocabulary): `request_gone` — the request / broadcast / member
 * is gone; `recipient_gone` — nobody to send to any more; `request_superseded`
 * — the hand-off is stale (a normal flow: the silent skip); `request_not_decided`
 * — the F114 member arm's request is not `decided` (unreachable by
 * construction; kept LOUD).
 */
export interface PayloadMiss {
  readonly miss: 'request_gone' | 'recipient_gone' | 'request_superseded' | 'request_not_decided';
}

/** A transient failure the arm named — today only a failed dependency read. */
export interface PayloadTransient {
  readonly transient: 'read_failed';
}

/** Every way `buildPayload` can answer without a payload. */
export type UnbuiltPayload = PayloadMiss | PayloadTransient | null;

/** The labels `outbox_permanent_failures_total` takes for an unrendered row. */
export type UnbuiltFailureReason = Exclude<PayloadMiss['miss'], 'request_superseded'> | PayloadTransient['transient'] | 'no_template_handler';

export interface UnbuiltPayloadOutcome {
  /** Close the row now (`permanently_failed`) rather than schedule a retry. */
  readonly permanent: boolean;
  /** `last_error` and the audit payload's `reason`. */
  readonly reason: PayloadMiss['miss'] | UnbuiltFailureReason;
  /** The failure-metric label; `null` for the silent `request_superseded`, which is no failure. */
  readonly metricReason: UnbuiltFailureReason | null;
}

export function isPayloadMiss(v: unknown): v is PayloadMiss {
  return typeof v === 'object' && v !== null && 'miss' in v;
}

export function isPayloadTransient(v: unknown): v is PayloadTransient {
  return typeof v === 'object' && v !== null && 'transient' in v;
}

/**
 * The outcome for an unrendered row on attempt `nextAttempt` (1-based) of
 * `maxAttempts`.
 */
export function unbuiltPayloadOutcome(unbuilt: UnbuiltPayload, nextAttempt: number, maxAttempts: number): UnbuiltPayloadOutcome {
  if (isPayloadMiss(unbuilt)) {
    return { permanent: true, reason: unbuilt.miss, metricReason: unbuilt.miss === 'request_superseded' ? null : unbuilt.miss };
  }
  const reason = unbuilt === null ? 'no_template_handler' : unbuilt.transient;
  return { permanent: nextAttempt >= maxAttempts, reason, metricReason: reason };
}
