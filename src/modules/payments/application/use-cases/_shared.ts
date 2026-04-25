/**
 * Internal helpers shared across F5 webhook use-cases (R3 H1 + H2).
 *
 * Extracted from confirm-payment / fail-payment / handle-cancel-event
 * because:
 *
 *   - **markProcessedIfPresent** — the same `if (deps.processorEventsRepo
 *     && input.processorEventId) { await markProcessed(tx, ...) }` block
 *     repeated 9× across the three use-cases (audit 2026-04-25 #4
 *     atomic-markProcessed pattern). The optional-chain trap (forgetting
 *     either guard) was a real regression risk; centralising it makes
 *     the contract obvious + lint-checkable.
 *
 *   - **emitWebhookUnknownIntent** — the `webhook_unknown_intent` audit
 *     payload was identical between failPayment + handleCancelEvent
 *     except for the `event_type` literal. Best-effort emit (tx=null)
 *     so an audit-table outage cannot roll back markProcessed (per
 *     audit 2026-04-26 round-2 #R2-A1).
 *
 * Naming convention: leading underscore on the file (`_shared.ts`) marks
 * it as use-case-internal — not part of the public application surface.
 */
import type { AuditPort, ProcessorEventsRepo } from '../ports';
import { retentionFor } from '../ports/audit-port';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';

interface MarkProcessedDeps {
  readonly processorEventsRepo?: ProcessorEventsRepo;
}

interface MarkProcessedInput {
  readonly processorEventId?: string;
}

/**
 * Atomic markProcessed inside the caller's webhook-dispatch tx.
 *
 * Both deps + input are optional: production webhook dispatch always
 * supplies them, but unit tests that exercise the use-case in isolation
 * MAY omit either one (e.g. testing pure transition logic without the
 * processor_events bookkeeping). When either is missing this is a
 * silent no-op — same semantics as the inlined call sites it replaces.
 */
export async function markProcessedIfPresent(
  deps: MarkProcessedDeps,
  input: MarkProcessedInput,
  tx: unknown,
): Promise<void> {
  if (deps.processorEventsRepo && input.processorEventId) {
    await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
  }
}

interface UnknownIntentInput {
  readonly tenantId: string;
  readonly requestId: string | null;
  readonly paymentIntentId: string;
  readonly eventCreatedAtUnixSeconds: number;
}

/**
 * Best-effort `webhook_unknown_intent` audit (tx=null), emitted when a
 * payment-intent webhook arrives for an intent we don't have a row for
 * (Stripe replay against a test DB / cross-environment mis-route).
 *
 * `eventType` is the Stripe event type string ('payment_intent.payment_
 * failed' / 'payment_intent.canceled') — used only inside the audit
 * payload. The F5 audit eventType is always `webhook_unknown_intent`.
 */
export async function emitWebhookUnknownIntent(
  audit: AuditPort,
  input: UnknownIntentInput,
  eventType: string,
): Promise<void> {
  await audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId,
    eventType: 'webhook_unknown_intent',
    actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
    summary: `${eventType} for unknown intent ${input.paymentIntentId}`,
    payload: {
      processor_payment_intent_id: input.paymentIntentId,
      event_type: eventType,
      event_created_at_unix_seconds: input.eventCreatedAtUnixSeconds,
    },
    retentionYears: retentionFor('webhook_unknown_intent'),
  });
}
