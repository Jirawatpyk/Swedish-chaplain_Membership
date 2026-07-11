/**
 * T154 — `process-webhook-event.ts` Application use-case (F7 US5).
 *
 * Root dispatcher for verified Resend Broadcasts webhook events. The
 * route handler owns signature verification + JSON parsing (T160 / OWASP
 * A03 — verify before parse); this use-case picks up at the post-verify
 * boundary with a `VerifiedBroadcastEvent` envelope.
 *
 * Pipeline (FR-024 + FR-025 + FR-027):
 *   1. Open `broadcastsRepo.withTx(...)` — enters `runInTenant(ctx)` so
 *      every downstream write applies RLS+FORCE.
 *   2. Re-resolve the broadcast inside the tx via `findByIdInTx`. If the
 *      row's status is terminal (sent/cancelled/failed_to_dispatch) the
 *      event is acknowledged but ignored — late webhook deliveries from
 *      Resend after we've reconciled or terminated must NOT mutate state.
 *   3. Upsert `broadcast_deliveries(tenant_id, resend_event_id)` — replay
 *      returns `inserted=false` so we skip downstream side effects.
 *   4. Branch on event status; delegate to the four handlers (T155–T158).
 *   5. After any non-`sent`/`soft_bounced` event, check completion: if
 *      delivered + bounced + complained ≥ estimatedRecipientCount the
 *      broadcast transitions `sending → sent` AND quota is consumed
 *      (FR-007 — quota is recorded in the calendar year of `sentAt` in
 *      `tenantTimezone`).
 *
 * The `tenantId` comes pre-resolved from the route handler's call to
 * `resolveTenantByResendBroadcastId` (which wraps the bypass-RLS repo
 * lookup). This use-case trusts that input — cross-tenant safety is
 * re-asserted by the tx-binding probe in `BroadcastsRepo.withTx`
 * (existing pattern).
 *
 * Pure Application — only Domain types + ports.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { sha256Hex } from '@/lib/crypto';
import { unsafeIanaTimezone, type TenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';

import type { BroadcastId } from '../../domain/broadcast';
import { transition } from '../../domain/policies/broadcast-status-transitions';
import {
  asEmailLower,
  type EmailLower,
} from '../../domain/value-objects/email-lower';
import {
  asBroadcastDeliveryId,
  type BroadcastDeliveryId,
} from '../../domain/broadcast-delivery';
import type {
  AuditEmitInput,
  AuditPort,
  F7AuditEventType,
} from '../ports/audit-port';
import type {
  BroadcastDeliveriesRepo,
  NewBroadcastDeliveryInput,
} from '../ports/broadcast-deliveries-repo';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type {
  MarketingUnsubscribesRepo,
  NewSuppressionInput,
} from '../ports/marketing-unsubscribes-repo';
import type { MembersBridgePort } from '../ports/members-bridge-port';
import type { ClockPort } from '../ports/clock-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { VerifiedBroadcastEvent } from '../ports/webhook-verifier-port';

import { currentQuotaYear } from './compute-quota-counter';

// 5% per-broadcast complaint-rate threshold (Clarifications Q14 / SC-005 (b)).
const COMPLAINT_RATE_HALT_THRESHOLD = 0.05;

function newDeliveryId(): BroadcastDeliveryId {
  return asBroadcastDeliveryId(globalThis.crypto.randomUUID());
}

export type ProcessWebhookEventOutcome =
  | { readonly kind: 'duplicate'; readonly broadcastId: BroadcastId }
  | { readonly kind: 'broadcast_terminal'; readonly broadcastId: BroadcastId }
  | { readonly kind: 'unknown_broadcast' }
  | {
      readonly kind: 'recorded';
      readonly broadcastId: BroadcastId;
      readonly transitionedToSent: boolean;
      readonly suppressionAdded: boolean;
      readonly memberHalted: boolean;
    };

export type ProcessWebhookEventError =
  | { readonly kind: 'process_webhook.invalid_payload'; readonly reason: string }
  | { readonly kind: 'process_webhook.server_error'; readonly message: string };

export interface ProcessWebhookEventDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly deliveriesRepo: BroadcastDeliveriesRepo;
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
  readonly membersBridge: MembersBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * Optional — when present, the use-case enqueues the FR-028 / AS3
   * member summary email at the `sending → sent` transition. Email
   * enqueue is best-effort: failures are logged and swallowed so
   * webhook ingest does NOT 5xx Resend on a transient outbox-write
   * problem (Stripe-style "the audit row already committed; do not
   * fight the retry path"). Tests may omit this dep — tests that omit
   * it MUST assert no email was attempted.
   */
  readonly emailTransactional?: EmailTransactionalPort;
}

export interface ProcessWebhookEventInput {
  /**
   * Pre-resolved by the route via `resolveTenantByResendBroadcastId`.
   * Branded as `BroadcastId` at the route boundary; the use-case
   * trusts the input but re-fetches inside the tx for canonical state.
   */
  readonly broadcastId: BroadcastId;
  readonly event: VerifiedBroadcastEvent;
  readonly requestId: string | null;
}

export async function processWebhookEvent(
  deps: ProcessWebhookEventDeps,
  input: ProcessWebhookEventInput,
): Promise<Result<ProcessWebhookEventOutcome, ProcessWebhookEventError>> {
  const { event, broadcastId } = input;
  const tenantId = deps.tenant.slug;

  // Brand the recipient email to its EmailLower form. Reject malformed
  // payloads — verifier already loosely validated; this is defence in
  // depth (`asEmailLower` enforces lowercase + length + minimal regex).
  const recipientLower = asEmailLower(event.data.recipientEmail);
  if (!recipientLower.ok) {
    return err({
      kind: 'process_webhook.invalid_payload',
      reason: `recipient_email failed EmailLower validation: ${recipientLower.error.code}`,
    });
  }

  try {
    return await deps.broadcastsRepo.withTx(async (tx) => {
      // Re-fetch inside tx so we have the canonical persisted state
      // (the verifier-resolved `broadcast` may be stale if a prior
      // webhook in this batch already advanced it to `sent`).
      const fresh = await deps.broadcastsRepo.findByIdInTx(
        tx,
        tenantId,
        broadcastId,
      );
      if (fresh === null) {
        // Should not happen — bypass lookup found it < 1ms ago, but
        // race on tenant rebind would surface here. Treat as unknown.
        return ok({ kind: 'unknown_broadcast' as const });
      }

      // Bug #7 fix (2026-07-10): recipient-level suppression on hard-bounce /
      // complaint is INDEPENDENT of the broadcast lifecycle (FR-027 — "once
      // hard-bounced/complained, never email again"). Complaint feedback-loop
      // and many hard-bounce notifications routinely arrive hours-to-days
      // AFTER the broadcast reaches a terminal status, so the suppression
      // cascade must be reachable from the terminal branch too — not only
      // the non-terminal switch. Extracted as a closure so ALL THREE call
      // sites — the terminal branch AND the non-terminal `bounced`/`complained`
      // switch cases — share ONE implementation. The member-halt cascade +
      // completion check remain lifecycle-scoped and are NOT invoked here.
      const applySuppressionCascade = async (): Promise<boolean> => {
        const isHardBounce =
          event.data.status === 'bounced' && event.data.bounceType === 'hard';
        const isComplaint = event.data.status === 'complained';
        if (!isHardBounce && !isComplaint) return false;

        const reason = isHardBounce ? 'hard_bounce' : 'complaint';
        // Hash once — both audit emits below share the same value (re-review
        // finding #15; the digest is deterministic per (tenant, email)).
        const recipientEmailHashed = hashRecipient(tenantId, recipientLower.value);
        const suppressionInput: NewSuppressionInput = {
          tenantId,
          emailLower: recipientLower.value,
          memberId: null,
          reason,
          reasonText: event.data.errorMessage ?? null,
          sourceBroadcastId: broadcastId,
          sourceTokenHash: null,
        };
        const sup = await deps.marketingUnsubscribes.upsert(
          tx,
          suppressionInput,
        );
        if (isComplaint) {
          await deps.audit.emit(
            tx,
            f7Audit({
              eventType: 'broadcast_complaint_received',
              tenantId,
              actorUserId: 'system:resend-webhook',
              summary: `Complaint recorded on broadcast ${broadcastId}`,
              payload: {
                broadcastId,
                memberId: fresh.requestedByMemberId,
                recipientEmailHashed,
              },
              requestId: input.requestId,
            }),
          );
        }
        await deps.audit.emit(
          tx,
          f7Audit({
            eventType: 'broadcast_suppression_applied',
            tenantId,
            actorUserId: 'system:resend-webhook',
            summary: `${isHardBounce ? 'Hard bounce' : 'Complaint'} suppressed recipient on broadcast ${broadcastId}`,
            payload: {
              broadcastId,
              recipientEmailHashed,
              reason,
              // Preserve the hard-bounce audit's bounceType field so the
              // non-terminal switch can route through this same closure.
              ...(isHardBounce && {
                bounceType: event.data.bounceType ?? null,
              }),
            },
            requestId: input.requestId,
          }),
        );
        return sup.wasNew;
      };

      // Bug #10 fix (2026-07-10): `email.unsubscribed` reaches the F7 MVP
      // (single-audience) path when a recipient uses Resend's managed
      // unsubscribe link. It is NOT a `broadcast_deliveries` enum value, so
      // it must be handled BEFORE the delivery-row insert (which would fail
      // the pg enum) — we record it as a recipient-level suppression instead.
      // Multi-batch broadcasts never reach here: the route increments the
      // per-batch `unsubscribed_count` and returns early. Idempotent — the
      // suppression upsert's `wasNew` gates the audit emit against replays.
      if (event.data.status === 'unsubscribed') {
        const sup = await deps.marketingUnsubscribes.upsert(tx, {
          tenantId,
          emailLower: recipientLower.value,
          memberId: null,
          reason: 'recipient_initiated',
          reasonText: null,
          sourceBroadcastId: broadcastId,
          sourceTokenHash: null,
        });
        if (sup.wasNew) {
          await deps.audit.emit(
            tx,
            f7Audit({
              eventType: 'broadcast_suppression_applied',
              tenantId,
              actorUserId: 'system:resend-webhook',
              summary: `Recipient unsubscribed via Resend on broadcast ${broadcastId}`,
              payload: {
                broadcastId,
                recipientEmailHashed: hashRecipient(
                  tenantId,
                  recipientLower.value,
                ),
                reason: 'recipient_initiated',
              },
              requestId: input.requestId,
            }),
          );
        }
        return ok({
          kind: 'recorded' as const,
          broadcastId,
          transitionedToSent: false,
          suppressionAdded: sup.wasNew,
          memberHalted: false,
        });
      }

      if (
        fresh.status === 'sent' ||
        fresh.status === 'cancelled' ||
        fresh.status === 'failed_to_dispatch' ||
        fresh.status === 'rejected'
      ) {
        // Late event after terminal state — record the delivery row for
        // forensics but do not mutate broadcast state.
        const deliveryInput: NewBroadcastDeliveryInput = {
          tenantId,
          deliveryId: newDeliveryId(),
          broadcastId,
          resendEventId: event.id,
          resendMessageId: event.data.resendMessageId,
          recipientEmailLower: recipientLower.value,
          recipientMemberId: null,
          recipientMemberLookupAttemptedAt: null,
          status: event.data.status,
          eventTimestamp: new Date(event.createdAtUnixSeconds * 1000),
          errorMessage: event.data.errorMessage ?? null,
          bounceType: event.data.bounceType ?? null,
        };
        const upsert = await deps.deliveriesRepo.upsertByResendEventId(
          tx,
          deliveryInput,
        );
        // Review ERR-H2: emit `broadcast_concurrent_action_blocked` only
        // for genuinely-new late events (not idempotent replays). This
        // makes "Resend kept firing complaints after we marked the
        // broadcast sent/cancelled" observable in `audit_log` — a
        // compliance-relevant signal that was previously silent.
        if (upsert.inserted) {
          await deps.audit.emit(
            tx,
            f7Audit({
              eventType: 'broadcast_concurrent_action_blocked',
              tenantId,
              actorUserId: 'system:resend-webhook',
              summary: `Late ${event.data.status} event arrived for broadcast ${broadcastId} already in terminal status ${fresh.status}`,
              payload: {
                broadcastId,
                terminalStatus: fresh.status,
                lateEventStatus: event.data.status,
                resendEventId: event.id,
                recipientEmailHashed: hashRecipient(tenantId, recipientLower.value),
              },
              requestId: input.requestId,
            }),
          );
          // Bug #7 fix: apply recipient suppression for a genuinely-new late
          // hard-bounce/complaint event even though the broadcast is already
          // terminal (FR-027). Idempotent — gated on the delivery-row insert
          // above so replays never re-suppress or re-audit.
          await applySuppressionCascade();
        }
        return ok({
          kind: 'broadcast_terminal' as const,
          broadcastId,
        });
      }

      const deliveryInput: NewBroadcastDeliveryInput = {
        tenantId,
        deliveryId: newDeliveryId(),
        broadcastId,
        resendEventId: event.id,
        resendMessageId: event.data.resendMessageId,
        recipientEmailLower: recipientLower.value,
        recipientMemberId: null,
        recipientMemberLookupAttemptedAt: null,
        status: event.data.status,
        eventTimestamp: new Date(event.createdAtUnixSeconds * 1000),
        errorMessage: event.data.errorMessage ?? null,
        bounceType: event.data.bounceType ?? null,
      };

      const upsertResult = await deps.deliveriesRepo.upsertByResendEventId(
        tx,
        deliveryInput,
      );
      if (!upsertResult.inserted) {
        // FR-025 idempotency: replay → no downstream side effects.
        return ok({ kind: 'duplicate' as const, broadcastId });
      }

      let suppressionAdded = false;
      let memberHalted = false;

      // --- Branch on event type --------------------------------------
      switch (event.data.status) {
        case 'sent':
          // No-op — Resend accepted from us. Completion check below
          // pivots on terminal events (delivered/bounced/complained).
          break;
        case 'delivered':
          // R6 staff-review B1 fix — was incorrectly emitting
          // `broadcast_send_started` (the dispatch use-case's send-init
          // event), polluting the audit trail and the SLO-F7-005 metric
          // cardinality. `broadcast_delivery_recorded` is the correct
          // per-recipient delivery-confirmation semantic.
          await deps.audit.emit(
            tx,
            f7Audit({
              eventType: 'broadcast_delivery_recorded',
              tenantId,
              actorUserId: 'system:resend-webhook',
              summary: `Broadcast ${broadcastId}: delivery recorded`,
              payload: {
                broadcastId,
                resendEventId: event.id,
                recipientEmailHashed: hashRecipient(tenantId, recipientLower.value),
              },
              requestId: input.requestId,
            }),
          );
          break;
        case 'bounced':
          // Hard bounce → suppress via the shared cascade (it no-ops on soft
          // bounces). Cleanup: was an inline copy of the suppression logic.
          if (await applySuppressionCascade()) suppressionAdded = true;
          break;
        case 'soft_bounced':
          // Resend retries internally; no suppression cascade. Row is
          // recorded for diagnostics only.
          break;
        case 'complained': {
          // Suppress + emit complaint_received/suppression_applied via the
          // shared cascade (cleanup: was an inline copy). The per-broadcast
          // complaint-rate auto-halt below is lifecycle-scoped and stays here.
          if (await applySuppressionCascade()) suppressionAdded = true;
          // Per-broadcast >5% complaint-rate auto-halt (Clarifications
          // Q14, B / SC-005 (b)). Computed against running aggregate
          // INSIDE the same tx so concurrent complaint events converge
          // to a stable decision (the row was just upserted above so
          // the count includes this event).
          //
          // Implementation note (verify finding E1 — 2026-05-01):
          // SC-005 (b) text says "any single broadcast whose complaint
          // rate exceeds 5%". Verbatim, that triggers a halt on
          // 1-out-of-1 complaint events (100% rate, n=1). To prevent
          // spurious halts on tiny audiences (e.g. an early-event
          // burst from 3-recipient broadcasts) we add a 20-event
          // small-N noise floor — below it we still record the
          // suppression + complaint audit, but defer the halt decision
          // to subsequent events. 20 events × >5% threshold = ≥1
          // complaint AND ≥20 terminal events; the practical effect is
          // the halt fires the moment a real-world deliverability
          // problem becomes statistically distinguishable from noise.
          // Documented as an implementation refinement of FR-027 +
          // SC-005 (b); does NOT relax the spec, only filters noise.
          //
          // E2 (verify finding) — paging contract: emit IS the trigger.
          // The `broadcast_complaint_rate_per_broadcast_breach` audit
          // event below is consumed by the alert pipeline (high-severity
          // audit rows page on-call admin via the deliverability
          // runbook). This use-case does NOT directly call PagerDuty /
          // Opsgenie — separation of concerns: the audit-rail is the
          // SLO-tracked trigger, not bespoke webhook→pager plumbing.
          const agg = await deps.deliveriesRepo.aggregateByBroadcast(
            tenantId,
            broadcastId,
            tx,
          );
          const terminalCount = agg.delivered + agg.bounced + agg.complained;
          const SMALL_N_NOISE_FLOOR = 20;
          if (
            agg.complained > 0 &&
            terminalCount >= SMALL_N_NOISE_FLOOR &&
            agg.complained / terminalCount > COMPLAINT_RATE_HALT_THRESHOLD &&
            fresh.requestedByMemberId !== null &&
            !memberHalted
          ) {
            // R7 staff-review MED-S3 fix — privilege-check defence in
            // depth. `setMemberHalt` is a privileged action (only
            // system + admin contexts may halt; member self-service
            // is forbidden per FR-027 / Q14). The webhook entrypoint
            // is the SOLE call site for this branch and it always
            // runs under a system actor. Use-case-internal assertion
            // documents the invariant and fails fast on a future
            // refactor that exposes this branch to non-system actors.
            // The `processWebhookEvent` use-case is itself trusted
            // because (a) the route handler verifies Svix HMAC
            // signature before calling, (b) the use-case has no
            // member-input parameter, and (c) the actor literal
            // `'system:resend-webhook'` is hard-coded in the emit
            // sites below. Branded `WebhookActor` type would be
            // equivalent but heavier; runtime invariant + comment
            // is the lighter-weight equivalent.
            const halt = await deps.membersBridge.setMemberHalt(
              deps.tenant,
              fresh.requestedByMemberId,
              true,
            );
            if (halt.ok) {
              memberHalted = true;
              await deps.audit.emit(
                tx,
                f7Audit({
                  eventType: 'broadcast_complaint_rate_per_broadcast_breach',
                  tenantId,
                  actorUserId: 'system:resend-webhook',
                  summary: `Per-broadcast complaint rate >5% on ${broadcastId} — member auto-halted`,
                  payload: {
                    broadcastId,
                    memberId: fresh.requestedByMemberId,
                    complaintRate: agg.complained / terminalCount,
                    threshold: COMPLAINT_RATE_HALT_THRESHOLD,
                    recipientsAtBreach: terminalCount,
                  },
                  requestId: input.requestId,
                }),
              );
            } else {
              logger.error(
                {
                  tenantId,
                  broadcastId,
                  memberId: fresh.requestedByMemberId,
                  haltError: halt.error.kind,
                },
                'broadcasts.webhook.member_halt_failed',
              );
            }
          }
          break;
        }
      }

      // --- Completion check (transition to 'sent') --------------------
      let transitionedToSent = false;
      if (
        fresh.status === 'sending' &&
        (event.data.status === 'delivered' ||
          event.data.status === 'bounced' ||
          event.data.status === 'complained')
      ) {
        const agg = await deps.deliveriesRepo.aggregateByBroadcast(
          tenantId,
          broadcastId,
          tx,
        );
        const terminalCount = agg.delivered + agg.bounced + agg.complained;
        // T172 — emit per-broadcast deliverability gauges. Only after
        // a noise floor (>=5 events) so an early single-bounce doesn't
        // spike the gauge to 1.0 / 0% complaint. Cardinality bounded
        // by recipient cap × broadcasts/year/tenant per docs § 22.1.
        if (terminalCount >= 5) {
          broadcastsMetrics.bounceRatePerBroadcast(
            tenantId,
            broadcastId as unknown as string,
            agg.bounced / terminalCount,
          );
          broadcastsMetrics.complaintRatePerBroadcast(
            tenantId,
            broadcastId as unknown as string,
            agg.complained / terminalCount,
          );
        }
        // R6 staff-review B2 fix — zero-recipient guard. Without the
        // `> 0` predicate, a row that arrives at `sending` with
        // `estimatedRecipientCount = 0` would transition to `sent` and
        // consume the member's annual quota on the very first webhook
        // event. The DB CHECK (`broadcasts_estimated_recipient_count`
        // BETWEEN 0 AND 5000) permits 0; the App-layer guard is the
        // only safety net. A 0-count row reaching `sending` indicates
        // a dispatch-logic bug (segment resolved to 0 should fail at
        // submit per FR-002c `broadcast_empty_segment_blocked`); the
        // guard prevents silent quota corruption while the bug is
        // diagnosed.
        if (
          fresh.estimatedRecipientCount > 0 &&
          terminalCount >= fresh.estimatedRecipientCount
        ) {
          const transitionResult = transition(fresh.status, 'sent');
          if (transitionResult.ok) {
            const now = deps.clock.now();
            const tenantTz = unsafeIanaTimezone(env.tenant.timezone);
            const quotaYear = currentQuotaYear(now, tenantTz);

            await deps.broadcastsRepo.applyTransition(
              tx,
              tenantId,
              broadcastId,
              'sent',
              {
                sentAt: now,
                quotaYearConsumed: quotaYear,
                quotaConsumedAt: now,
              },
              'sending', // R4 Types-#5 — webhook only fires on 'sending' rows
            );
            transitionedToSent = true;

            await deps.audit.emit(
              tx,
              f7Audit({
                eventType: 'broadcast_sent',
                tenantId,
                actorUserId: 'system:resend-webhook',
                summary: `Broadcast ${broadcastId} transitioned to sent (all ${fresh.estimatedRecipientCount} terminal events received)`,
                payload: {
                  broadcastId,
                  memberId: fresh.requestedByMemberId,
                  sentAt: now.toISOString(),
                  delivered: agg.delivered,
                  bounced: agg.bounced,
                  complained: agg.complained,
                },
                requestId: input.requestId,
              }),
            );
            await deps.audit.emit(
              tx,
              f7Audit({
                eventType: 'broadcast_quota_consumed',
                tenantId,
                actorUserId: 'system:resend-webhook',
                summary: `Quota slot consumed for broadcast ${broadcastId} (year ${quotaYear})`,
                payload: {
                  broadcastId,
                  memberId: fresh.requestedByMemberId,
                  quotaYear,
                  quotaConsumedAt: now.toISOString(),
                },
                requestId: input.requestId,
              }),
            );

            // FR-028 / AS3 — enqueue the transactional summary email.
            // Best-effort: a failure here does NOT roll back the
            // tx-committed sent transition + audit rows. Mirrors the
            // F4 receipt-email pattern (ship the state change first,
            // notify second; the dispatcher cron will retry the
            // outbox row on transient outages). Uses the shared
            // `enqueueDeliverySummaryEmail` helper so both the webhook
            // and reconciliation paths emit through one implementation
            // (review SIMPLIFY consolidation, 2026-05-01).
            await enqueueDeliverySummaryEmail({
              tenant: deps.tenant,
              ...(deps.emailTransactional !== undefined && {
                emailTransactional: deps.emailTransactional,
              }),
              membersBridge: deps.membersBridge,
              broadcastId,
              memberId: fresh.requestedByMemberId,
              broadcastSubject: fresh.subject,
              aggregate: agg,
              estimatedRecipientCount: fresh.estimatedRecipientCount,
              source: 'webhook',
              tx,
            });
          }
        }
      }

      return ok({
        kind: 'recorded' as const,
        broadcastId,
        transitionedToSent,
        suppressionAdded,
        memberHalted,
      });
    });
  } catch (e) {
    // Review ERR-M2 + ERR-L-R3-2 (round 3): log the full error before
    // wrapping so the route log carries stack + cause + constructor
    // name. Wrapping into a Result strips this info, but operators
    // need it for triage on unexpected failures (RLS probe, DB drop,
    // programmer bugs).
    //
    // R7 staff-review LOW-D fix — strip `cause` chain to a narrow
    // `{ message, name }` shape. Pino's default error serialiser
    // traverses `cause` recursively and SQL Drizzle errors can carry
    // recipient email or body content in the wrapped query text;
    // those values are NOT covered by `REDACT_PATHS` (paths match
    // field names, not string-content within err.message). Mirrors
    // the `enqueueDeliverySummaryEmail` catch-block pattern at line
    // 695. Operators retain the message + name for triage; the full
    // stack is available on the original throw via the OTel span
    // recordException path which never goes to log sinks.
    logger.error(
      {
        err:
          e instanceof Error
            ? { message: e.message, name: e.name }
            : String(e),
        tenantId,
        broadcastId,
        eventId: event.id,
      },
      'broadcasts.process_webhook.uncaught',
    );
    return err({
      kind: 'process_webhook.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function f7Audit(args: {
  readonly eventType: F7AuditEventType;
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
  readonly requestId: string | null;
}): AuditEmitInput {
  return {
    eventType: args.eventType,
    tenantId: args.tenantId,
    actorUserId: args.actorUserId,
    summary: args.summary,
    payload: args.payload,
    requestId: args.requestId,
  };
}

/**
 * Non-reversible-from-raw-scan hash of the lowercased recipient email
 * for audit-payload redaction. Audit log MUST NEVER carry raw recipient
 * emails (FR-042 + privacy.md). Hashing inside the use-case keeps the
 * redaction invariant at the Application boundary.
 *
 * T199 M-2 / T198 T-F7-04 (Phase 10 — 2026-05-02): hash family
 * upgraded from FNV-1a to SHA-256 with per-tenant scope. FNV-1a was
 * brute-forceable for the bounded SweCham recipient set (~131
 * members) and unscoped — two tenants' audit dumps could correlate
 * recipient presence via identical hashes. Now aligned with
 * `unsubscribe-recipient.ts` which already uses
 * `sha256Hex(tenantId + ':' + email)`.
 *
 * Existing `audit_log` rows with `fnv64:` prefix are unaffected
 * (immutable per append-only triggers); new rows use the
 * `sha256:<24-hex>` prefix for forensic distinguishability.
 */
function hashRecipient(tenantId: string, emailLower: EmailLower): string {
  return `sha256:${sha256Hex(`${tenantId}:${emailLower}`).slice(0, 24)}`;
}

/**
 * Single FR-028 / AS3 transactional summary-email enqueue helper used
 * by BOTH the webhook completion path (process-webhook-event) and the
 * 24h reconciliation path (reconcile-stuck-sending). Best-effort:
 * failures are logged and swallowed so the caller's tx-committed sent
 * transition + audit rows are NOT rolled back on a transient outbox
 * outage (mirrors the F4 receipt-email pattern).
 *
 * Member-lookup failure and outbox-insert failure are reported through
 * distinct log channels (review ERR-H1) so on-call diagnoses the right
 * system: `broadcasts.delivered_email.member_lookup_failed` vs
 * `broadcasts.delivered_email.enqueue_failed`.
 *
 * Exported (rather than file-local) for the reconciliation path —
 * keeping ONE implementation here beats duplicating the
 * member-lookup → payload-build → enqueue pipeline across two files.
 * If a third sent-transition path emerges (e.g. F8 admin manual-mark-sent),
 * promote to `src/modules/broadcasts/application/services/`.
 */
export async function enqueueDeliverySummaryEmail(args: {
  readonly tenant: TenantContext;
  readonly emailTransactional?: EmailTransactionalPort;
  readonly membersBridge: MembersBridgePort;
  readonly broadcastId: BroadcastId;
  readonly memberId: string;
  readonly broadcastSubject: string;
  readonly aggregate: { delivered: number; bounced: number; complained: number };
  readonly estimatedRecipientCount: number;
  /**
   * Discriminator — `'webhook'` when called from `processWebhookEvent`
   * (sending → sent on terminal-event completion), `'reconciliation'`
   * when called from `reconcileStuckSending` (24h timeout). Surfaces
   * in the outbox payload so the dispatcher can render the appropriate
   * subject line ("(reconciled at timeout)" suffix on the latter).
   */
  readonly source: 'webhook' | 'reconciliation';
  /**
   * Caller's tx handle (review ERR-C1). When the outbox INSERT MUST
   * commit atomically with the broadcast_sent transition, pass the
   * `withTx` callback's tx. The webhook + reconcile paths both call
   * inside a `broadcastsRepo.withTx` scope so this is non-null in
   * production; tests may pass `null` to enqueue on an autocommit
   * connection.
   */
  readonly tx: unknown | null;
}): Promise<void> {
  if (args.emailTransactional === undefined) return;

  let memberEmail: string | null;
  try {
    memberEmail = await args.membersBridge.getMemberPrimaryContact(
      args.tenant,
      args.memberId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: args.tenant.slug,
        broadcastId: args.broadcastId,
        memberId: args.memberId,
      },
      'broadcasts.delivered_email.member_lookup_failed',
    );
    return;
  }
  if (memberEmail === null) {
    logger.warn(
      {
        tenantId: args.tenant.slug,
        broadcastId: args.broadcastId,
        memberId: args.memberId,
      },
      'broadcasts.delivered_email.skipped_no_primary_contact',
    );
    return;
  }

  const total = args.estimatedRecipientCount;
  const deliveryRate =
    total > 0 ? Math.round((args.aggregate.delivered / total) * 1000) / 10 : 0;
  try {
    await args.emailTransactional.sendMemberEmail(
      args.tenant,
      {
        to: memberEmail,
        subject: args.broadcastSubject,
        templateKey: 'broadcast_delivered',
        payload: {
          broadcastId: args.broadcastId,
          broadcastSubject: args.broadcastSubject,
          delivered: args.aggregate.delivered,
          bounced: args.aggregate.bounced,
          complained: args.aggregate.complained,
          total,
          deliveryRate,
          source: args.source,
          viaReconciliation: args.source === 'reconciliation',
        },
        // Locale resolution: deferred to the F4 outbox dispatcher which
        // will look up `members.preferred_locale` at render time. We
        // pass 'en' as the enqueue-time fallback (dispatcher overrides
        // when the member row carries a non-default preference).
        locale: 'en',
      },
      args.tx,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: args.tenant.slug,
        broadcastId: args.broadcastId,
        memberId: args.memberId,
      },
      'broadcasts.delivered_email.enqueue_failed',
    );
  }
}
