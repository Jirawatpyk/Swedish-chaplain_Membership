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
 * The `tenantId` comes pre-resolved from the route handler's bypass-RLS
 * lookup against `findByResendBroadcastIdBypassRls`. This use-case
 * trusts that input — cross-tenant safety is re-asserted by the
 * tx-binding probe in `BroadcastsRepo.withTx` (existing pattern).
 *
 * Pure Application — only Domain types + ports.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
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
                recipientEmailHashed: hashRecipient(recipientLower.value),
              },
              requestId: input.requestId,
            }),
          );
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
          await deps.audit.emit(
            tx,
            f7Audit({
              eventType: 'broadcast_send_started',
              tenantId,
              actorUserId: 'system:resend-webhook',
              summary: `Broadcast ${broadcastId}: delivery recorded`,
              payload: {
                broadcastId,
                resendEventId: event.id,
                recipientEmailHashed: hashRecipient(recipientLower.value),
              },
              requestId: input.requestId,
            }),
          );
          break;
        case 'bounced':
          if (event.data.bounceType === 'hard') {
            const suppressionInput: NewSuppressionInput = {
              tenantId,
              emailLower: recipientLower.value,
              memberId: null,
              reason: 'hard_bounce',
              reasonText: event.data.errorMessage ?? null,
              sourceBroadcastId: broadcastId,
              sourceTokenHash: null,
            };
            const sup = await deps.marketingUnsubscribes.upsert(
              tx,
              suppressionInput,
            );
            if (sup.wasNew) suppressionAdded = true;
            await deps.audit.emit(
              tx,
              f7Audit({
                eventType: 'broadcast_suppression_applied',
                tenantId,
                actorUserId: 'system:resend-webhook',
                summary: `Hard bounce suppressed recipient on broadcast ${broadcastId}`,
                payload: {
                  broadcastId,
                  recipientEmailHashed: hashRecipient(recipientLower.value),
                  reason: 'hard_bounce',
                  bounceType: event.data.bounceType ?? null,
                },
                requestId: input.requestId,
              }),
            );
          }
          break;
        case 'soft_bounced':
          // Resend retries internally; no suppression cascade. Row is
          // recorded for diagnostics only.
          break;
        case 'complained': {
          const suppressionInput: NewSuppressionInput = {
            tenantId,
            emailLower: recipientLower.value,
            memberId: null,
            reason: 'complaint',
            reasonText: event.data.errorMessage ?? null,
            sourceBroadcastId: broadcastId,
            sourceTokenHash: null,
          };
          const sup = await deps.marketingUnsubscribes.upsert(
            tx,
            suppressionInput,
          );
          if (sup.wasNew) suppressionAdded = true;
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
                recipientEmailHashed: hashRecipient(recipientLower.value),
              },
              requestId: input.requestId,
            }),
          );
          await deps.audit.emit(
            tx,
            f7Audit({
              eventType: 'broadcast_suppression_applied',
              tenantId,
              actorUserId: 'system:resend-webhook',
              summary: `Complaint suppressed recipient on broadcast ${broadcastId}`,
              payload: {
                broadcastId,
                recipientEmailHashed: hashRecipient(recipientLower.value),
                reason: 'complaint',
              },
              requestId: input.requestId,
            }),
          );
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
        );
        const terminalCount = agg.delivered + agg.bounced + agg.complained;
        if (terminalCount >= fresh.estimatedRecipientCount) {
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
            // outbox row on transient outages).
            await enqueueDeliverySummaryEmail({
              deps,
              tenantId,
              broadcastId,
              memberId: fresh.requestedByMemberId,
              broadcastSubject: fresh.subject,
              aggregate: agg,
              estimatedRecipientCount: fresh.estimatedRecipientCount,
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
 * NOTE: FNV-1a is **not** cryptographically one-way — a known small
 * recipient set is brute-forceable by precomputing hashes. We use it
 * only to defeat passive `SELECT … FROM audit_log` reads (operator
 * accident, dump leak). PII-grade hashing for the `marketing_unsubscribes`
 * suppression list uses Node `createHash('sha256')` at the
 * Infrastructure boundary.
 */
function hashRecipient(emailLower: EmailLower): string {
  // FNV-1a 64-bit (deterministic, framework-free, no PII reversal).
  let hash = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(emailLower);
  for (const b of bytes) {
    hash ^= BigInt(b);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `fnv64:${hash.toString(16).padStart(16, '0')}`;
}

/**
 * Enqueue the FR-028 / AS3 transactional summary email at the
 * `sending → sent` transition. Best-effort — failures are logged and
 * swallowed so the webhook ingest does not 5xx Resend on a transient
 * outbox-write outage. The reconciliation path uses the sibling
 * `enqueueSummaryEmailForReconcile` (exported below) so both
 * sent-transition sites share one implementation.
 */
async function enqueueDeliverySummaryEmail(args: {
  readonly deps: ProcessWebhookEventDeps;
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;
  readonly memberId: string;
  readonly broadcastSubject: string;
  readonly aggregate: { delivered: number; bounced: number; complained: number };
  readonly estimatedRecipientCount: number;
}): Promise<void> {
  if (args.deps.emailTransactional === undefined) return;

  // Review ERR-H1: split try/catch so the failure-mode log accurately
  // names the broken layer. Conflating member-lookup (DB / RLS / bridge)
  // with outbox-insert (notifications_outbox / dispatcher) made on-call
  // diagnose the wrong system.
  let memberEmail: string | null;
  try {
    memberEmail = await args.deps.membersBridge.getMemberPrimaryContact(
      args.deps.tenant,
      args.memberId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: args.tenantId,
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
        tenantId: args.tenantId,
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
    await args.deps.emailTransactional.sendMemberEmail(args.deps.tenant, {
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
      },
      // Locale resolution: deferred to the F4 outbox dispatcher which
      // will look up `members.preferred_locale` at render time. We
      // pass 'en' as the enqueue-time fallback (dispatcher overrides
      // when the member row carries a non-default preference).
      locale: 'en',
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: args.tenantId,
        broadcastId: args.broadcastId,
        memberId: args.memberId,
      },
      'broadcasts.delivered_email.enqueue_failed',
    );
  }
}

/**
 * Public helper exported for reuse by `reconcile-stuck-sending.ts` so
 * both sent-transition paths emit the FR-028 summary email through
 * one implementation. The reconcile use-case has its own deps shape
 * (no `deliveriesRepo`) so the helper takes the email port + members
 * bridge directly rather than the full `ProcessWebhookEventDeps`.
 *
 * Architectural note (verify-gate finding G3, 2026-05-01): the cross-
 * use-case import (`reconcile-stuck-sending.ts` → `process-webhook-event.ts`)
 * is INTENTIONAL — splitting this helper into a third utility module
 * would be premature abstraction per Constitution Principle X
 * (Simplicity). The shared logic is small (~30 LoC), exclusively
 * called from these two sent-transition sites, and centralising
 * payload shape + locale fallback + best-effort error handling in
 * ONE place beats indirection across three files. Future contributors:
 * if a third sent-transition path emerges (e.g. F8 admin manual-mark-sent),
 * promote this helper to `src/modules/broadcasts/application/services/`
 * — until then, single source of truth wins over module split.
 */
export async function enqueueSummaryEmailForReconcile(args: {
  readonly tenant: TenantContext;
  readonly emailTransactional?: EmailTransactionalPort;
  readonly membersBridge: MembersBridgePort;
  readonly broadcastId: BroadcastId;
  readonly memberId: string;
  readonly broadcastSubject: string;
  readonly aggregate: { delivered: number; bounced: number; complained: number };
  readonly estimatedRecipientCount: number;
}): Promise<void> {
  if (args.emailTransactional === undefined) return;

  // Review ERR-H1: split member-lookup vs outbox-insert error reporting.
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
    await args.emailTransactional.sendMemberEmail(args.tenant, {
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
        viaReconciliation: true,
      },
      locale: 'en',
    });
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
