/**
 * T057 (F7.1a US1) — `applyBatchWebhookEvent` Application use case.
 *
 * Per-batch counter increment for Resend webhook events
 * (email.delivered / email.bounced / email.complained /
 * email.unsubscribed). Companion to the F7 MVP `processWebhookEvent`
 * which handles single-audience broadcasts; this use case handles
 * F7.1a multi-batch broadcasts where each batch has its own Resend
 * broadcast resource id.
 *
 * Routing: the webhook route looks up the incoming event's
 * `data.broadcastId` (Resend's broadcast id) via
 *   `BatchManifestsPort.findBatchByProviderBroadcastIdBypassRls`
 * (schema-owner BYPASSRLS read, mirrors F7 MVP `findByResend…`
 * pattern). On hit, the route invokes this use case with the
 * resolved tenantId + batchManifestId + event type.
 *
 * Counter semantics — exactly one counter increments per event:
 *   email.delivered   → batch_manifests.delivered_count++
 *   email.bounced     → batch_manifests.bounced_count++
 *   email.complained  → batch_manifests.complained_count++
 *   email.unsubscribed → batch_manifests.unsubscribed_count++
 *
 * Status transitions:
 *   - This use case does NOT itself transition the batch to 'sent'. The
 *     parent broadcast's `sending → sent | partially_sent` roll-up is now
 *     built — `roll-up-batch-broadcast.ts` (`evaluateBatchCompletion` keys
 *     "cleanly sent" on delivered+bounced+complained >= recipient_count),
 *     driven by the reconcile-stuck-sending cron sweep
 *     (`sweepBatchCompletion`). This use case only increments the per-batch
 *     counters that roll-up reads.
 *
 * Idempotency: dedup is OWNED HERE, at the repo layer — `incrementCounter`
 * inserts the event into the `broadcast_batch_delivery_events` ledger
 * (PK `(tenant_id, resend_event_id)`, ON CONFLICT DO NOTHING) in the same
 * tx as the counter UPDATE and returns `{ duplicate }`; a Resend/Svix
 * redelivery of the same `resend_event_id` is a no-op (F7-SF-1, migration
 * 0218). The earlier claim that `email_delivery_events.svix_id` dedups the
 * batch path was FALSE — that table is F1 transactional and is never
 * written on the batch path (see migration 0218 header).
 *
 * Pure orchestration — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { logAuditEmitFailure } from '../audit-emit-failure-logger';
import { safeAuditEmit } from './_safe-audit-emit';
import type {
  BatchCounterField,
  BatchManifestsPort,
} from '../ports/batch-manifests-port';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { MarketingUnsubscribesRepo } from '../ports/marketing-unsubscribes-repo';
import type { MarketingUnsubscribeReason } from '../../domain/marketing-unsubscribe';
import { unsafeBrandEmailLower } from '../../domain/value-objects/email-lower';
import { asBroadcastId } from '../../domain/broadcast';

/**
 * Bug #10 (code-review) — map a batch webhook event to the suppression reason
 * it triggers, or null when it does not suppress. Only HARD bounces suppress
 * (soft bounces are transient — Resend retries). No nested ternary
 * (CLAUDE.md forbids them).
 */
function suppressionReasonFor(
  eventType: BatchWebhookEventType,
  bounceType: 'hard' | 'soft' | undefined,
): MarketingUnsubscribeReason | null {
  if (eventType === 'unsubscribed') return 'recipient_initiated';
  if (eventType === 'complained') return 'complaint';
  if (eventType === 'bounced' && bounceType === 'hard') return 'hard_bounce';
  return null;
}

export type BatchWebhookEventType =
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'unsubscribed';

const EVENT_TO_COUNTER: Record<BatchWebhookEventType, BatchCounterField> = {
  delivered: 'deliveredCount',
  bounced: 'bouncedCount',
  complained: 'complainedCount',
  unsubscribed: 'unsubscribedCount',
};

export type ApplyBatchWebhookEventError =
  | { readonly kind: 'BATCH_NOT_FOUND'; readonly batchManifestId: string }
  | {
      readonly kind: 'apply_batch_webhook.server_error';
      readonly message: string;
    };

export interface ApplyBatchWebhookEventDeps {
  readonly batchManifests: BatchManifestsPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  // Bug #10 (code-review) — the batch path must ALSO suppress hard-bounce /
  // complaint / unsubscribe recipients (the MVP path already does).
  readonly marketingUnsubscribes: MarketingUnsubscribesRepo;
}

export interface ApplyBatchWebhookEventInput {
  readonly tenantId: string;
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly broadcastId: string;
  readonly eventType: BatchWebhookEventType;
  readonly recipientEmailHashed: string;
  /**
   * Plaintext lowercased recipient email — required for the suppression write
   * (marketing_unsubscribes is keyed on email_lower). NOT logged/audited raw
   * (audits use `recipientEmailHashed`).
   */
  readonly recipientEmailLower: string;
  /** Present on `bounced` events — only `hard` bounces suppress. */
  readonly bounceType?: 'hard' | 'soft';
  readonly resendEventId: string;
  readonly requestId?: string | null;
}

export async function applyBatchWebhookEvent(
  deps: ApplyBatchWebhookEventDeps,
  input: ApplyBatchWebhookEventInput,
): Promise<Result<void, ApplyBatchWebhookEventError>> {
  // T057 Phase 3C.4b — schema-owner-only adapter call requires the
  // raw string tenant slug (not a TenantContext). The webhook route
  // is responsible for tenant resolution + has the slug from the
  // bypass-RLS lookup.
  const counterField = EVENT_TO_COUNTER[input.eventType];

  const result = await deps.batchManifests.incrementCounter(
    input.tenantId as never, // TenantSlug brand — caller-validated
    input.batchManifestId,
    counterField,
    input.resendEventId,
  );

  if (!result.ok) {
    if (result.error.kind === 'not_found') {
      // Phase 3F.7 (F-23 fix) → Phase 3F.11.3 (M3 split) — emit a
      // forensic audit on the not-found race path. BYPASSRLS lookup
      // just resolved the tenantId, then the increment found 0 rows →
      // either the batch was force-deleted between the two queries
      // (admin ops action) OR the lookup returned a stale tenant
      // (impossible under current schema but future-proof).
      //
      // Phase 3F.11.3 (M3 — Round 2 fix) — uses the operational-
      // forensic event `broadcast_webhook_batch_missing` instead of
      // the security-forensic `broadcast_cross_tenant_probe` (kept
      // for admin/member-actor probes). The webhook race is benign;
      // mis-categorising it as a security probe pollutes the SIEM
      // feed with false-positive alerts.
      try {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          eventType: 'broadcast_webhook_batch_missing',
          actorUserId: 'system:resend-webhook',
          summary: `Webhook event for missing batch ${input.batchManifestId} (race window)`,
          payload: {
            broadcastId: input.broadcastId,
            batchManifestId: input.batchManifestId,
            batchIndex: input.batchIndex,
            resendEventType: input.eventType,
            resendEventId: input.resendEventId,
          },
          requestId: input.requestId ?? null,
        });
      } catch (auditErr) {
        // Phase 3F.11.9 (Round 3 comment-MED) — delegate to canonical
        // helper. Pass the operational-forensic log key (not the
        // security-forensic default) since M3 split this race-window
        // emit out of `broadcast_cross_tenant_probe`.
        logAuditEmitFailure(
          logger,
          {
            err: auditErr,
            tenantId: input.tenantId,
            broadcastId: input.broadcastId,
            batchManifestId: input.batchManifestId,
            batchIndex: input.batchIndex,
            eventType: input.eventType,
            resendEventId: input.resendEventId,
            // actorUserId is the webhook-system actor (not a user)
            actorUserId: 'system:resend-webhook',
            useCase: 'apply-batch-webhook-event',
          },
          'broadcasts.webhook_batch_missing.audit_emit_failed',
        );
      }
      return err({
        kind: 'BATCH_NOT_FOUND',
        batchManifestId: input.batchManifestId,
      });
    }
    return err({
      kind: 'apply_batch_webhook.server_error',
      message: result.error.detail,
    });
  }

  // F7-SF-1 — a Svix/Resend redelivery of an already-applied event id is a
  // no-op: the counter was bumped (and the delivery audited) on the FIRST
  // delivery. Short-circuit so the replay does not emit a duplicate
  // broadcast_delivery_recorded audit row; the webhook route still 200s.
  if (result.value.duplicate) {
    return ok(undefined);
  }

  // Audit emit — reuse `broadcast_delivery_recorded` event (added in
  // F7 MVP R6 staff-review) with `batchIndex` in payload for the
  // F71A surface. Same event type so the F9 audit-viewer doesn't
  // need a new filter; payload distinguishes broadcast-level vs
  // batch-level via presence/absence of `batchManifestId`.
  // Post-commit best-effort audit emit via `safeAuditEmit`. The counter
  // increment is the truth-of-record (committed in its own tx); an
  // audit-port outage AFTER it MUST NOT propagate to the webhook route as
  // a 500 (a 500 makes Svix retry the webhook). F7-SF-1 — that retry is
  // now SAFE: incrementCounter is idempotent on resendEventId, so a replay
  // returns { duplicate: true } and short-circuits ABOVE without
  // re-incrementing. The audit is observability; safeAuditEmit logs +
  // increments broadcasts_audit_emit_failed_total on failure and the
  // webhook still 200s.
  await safeAuditEmit(deps.audit, null, {
    tenantId: input.tenantId,
    eventType: 'broadcast_delivery_recorded',
    actorUserId: 'system:resend-webhook',
    summary: `Batch ${input.batchIndex} of broadcast ${input.broadcastId} recorded ${input.eventType} event`,
    payload: {
      broadcastId: input.broadcastId,
      batchManifestId: input.batchManifestId,
      batchIndex: input.batchIndex,
      eventType: input.eventType,
      counterField,
      recipientEmailHashed: input.recipientEmailHashed,
      resendEventId: input.resendEventId,
      recordedAt: deps.clock.now().toISOString(),
    },
    requestId: input.requestId ?? null,
  });

  // Bug #10 fix (code-review, 2026-07-11) — recipient-level suppression on the
  // MULTI-BATCH path. The MVP `processWebhookEvent` suppresses hard-bounce /
  // complaint / unsubscribe; this parallel path previously only COUNTED them,
  // leaving multi-batch recipients re-emailable by the next broadcast
  // (FR-027/FR-030 violation). We reach here only for a genuinely-new event
  // (the `duplicate` short-circuit above provides idempotency), so a single
  // suppression upsert per event is correct. `upsertStandalone` opens its own
  // tenant tx (this path has no caller tx). Best-effort: a suppression-write
  // failure MUST NOT 500 the webhook (the counter already committed; Svix would
  // otherwise retry) — log it for ops.
  const suppressionReason = suppressionReasonFor(input.eventType, input.bounceType);
  if (suppressionReason !== null && deps.marketingUnsubscribes.upsertStandalone) {
    try {
      const sup = await deps.marketingUnsubscribes.upsertStandalone({
        tenantId: input.tenantId,
        emailLower: unsafeBrandEmailLower(
          input.recipientEmailLower.toLowerCase().trim(),
        ),
        memberId: null,
        reason: suppressionReason,
        reasonText: null,
        sourceBroadcastId: asBroadcastId(input.broadcastId),
        sourceTokenHash: null,
      });
      if (sup.wasNew) {
        await safeAuditEmit(deps.audit, null, {
          tenantId: input.tenantId,
          eventType: 'broadcast_suppression_applied',
          actorUserId: 'system:resend-webhook',
          summary: `Batch ${input.batchIndex} of broadcast ${input.broadcastId}: ${suppressionReason} suppressed recipient`,
          payload: {
            broadcastId: input.broadcastId,
            batchManifestId: input.batchManifestId,
            batchIndex: input.batchIndex,
            reason: suppressionReason,
            recipientEmailHashed: input.recipientEmailHashed,
            resendEventId: input.resendEventId,
          },
          requestId: input.requestId ?? null,
        });
      }
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          tenantId: input.tenantId,
          broadcastId: input.broadcastId,
          batchManifestId: input.batchManifestId,
          reason: suppressionReason,
        },
        'broadcasts.batch.suppression_upsert_failed',
      );
    }
  }

  return ok(undefined);
}
