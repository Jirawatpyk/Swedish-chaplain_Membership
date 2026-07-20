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

/**
 * Task 5 (F-1 item 3) — the ONE detail string that welds two producers to one
 * consumer across a webhook boundary. `confirm-payment` and `fail-payment` both
 * refuse an unconfigured tenant with `bridge_error` + this detail; the webhook
 * dispatcher (`classifyDispatchPermanence`) special-cases it to `permanent` so
 * an unconfigured-tenant capture is 200-acked with a forensic row instead of
 * retried by Stripe for 48h against a state that cannot self-heal.
 *
 * Unlike the F4 half — compile-welded to `RecordPaymentError['code']` — this is
 * an F5-OWN guard with no shared type, so before this constant the contract was
 * three loose string literals. Renaming any one silently broke the
 * classification (all tests stayed green) → the tenant-unconfigured gap fell
 * through to `?? 'transient'` → 48h of retries + a give-up forensic stamped
 * `retry_ceiling_exceeded` that misdirects the operator to "F4/Blob was down two
 * days" when the truth is "F5 was never configured". Referencing this const at
 * all three sites turns that rename into a build error.
 */
export const F5_SETTINGS_MISSING_DETAIL = 'tenant_settings_missing' as const;

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
  // nullable to match `F5AuditEvent.tenantId: string | null`.
  // Today's callers always pass a resolved tenantId, but the audit
  // contract permits null (pre-resolution probe path); keeping the
  // helper input aligned avoids a future type-trap.
  readonly tenantId: string | null;
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

/**
 * H-11 / M-10 (review 2026-04-27) — emit the
 * `payment_acknowledged_terminal_state` forensic audit row for the
 * 4 webhook ack paths (illegal_transition x3 + invariant_violation x1).
 * Replaces 4 near-identical inline emit blocks (~80 LOC) and the
 * historical reuse of `payment_processor_retrieve_failed` (which is
 * reserved for actual Stripe SDK outages).
 *
 * Always emitted on `null` tx so the row survives the caller's
 * intentional rollback / about-to-finish-okay flow — these acks
 * commit forensic evidence even if subsequent steps are no-ops.
 */
interface IllegalTransitionAckInput {
  readonly tenantId: string | null;
  readonly requestId: string | null;
  readonly useCaseLabel: 'confirmPayment' | 'failPayment' | 'handleCancelEvent';
  readonly paymentIntentId: string;
  readonly paymentId: string;
  readonly fromStatus: string;
  /** `succeeded` | `failed` | `canceled` for the 3 use-cases */
  readonly toStatus: string;
  /** `illegal_transition` | `invariant_violation_duplicate_succeeded` */
  readonly mismatchKind: 'illegal_transition' | 'invariant_violation_duplicate_succeeded';
  /** Extra payload fields specific to the call site (e.g. `invoice_id`). */
  readonly extraPayload?: Readonly<Record<string, unknown>>;
}

export async function emitTerminalStateAck(
  audit: AuditPort,
  input: IllegalTransitionAckInput,
): Promise<void> {
  const summary =
    input.mismatchKind === 'invariant_violation_duplicate_succeeded'
      ? `${input.useCaseLabel} hit invariant_violation_duplicate_succeeded for payment ${input.paymentId} (acknowledged + no-op to break retry loop)`
      : `${input.useCaseLabel} hit illegal_transition from ${input.fromStatus} (acknowledged + no-op to break retry loop)`;
  await audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId,
    eventType: 'payment_acknowledged_terminal_state',
    actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
    summary,
    payload: {
      payment_intent_id: input.paymentIntentId,
      payment_id: input.paymentId,
      from_status: input.fromStatus,
      to_status: input.toStatus,
      mismatch_kind: input.mismatchKind,
      ...(input.extraPayload ?? {}),
    },
    retentionYears: retentionFor('payment_acknowledged_terminal_state'),
  });
}
