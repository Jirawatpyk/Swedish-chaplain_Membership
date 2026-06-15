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
 *   - Phase 3 Cluster 3C.4b MVP does NOT auto-transition the batch
 *     to 'sent' on terminal counter sum. That requires summing
 *     (delivered + bounced + complained + unsubscribed) ==
 *     recipient_count AND a sweep to update the parent broadcast
 *     aggregate status — deferred to Phase 3 Cluster 3D / Phase 3
 *     Cluster D advisory-lock-hardening.
 *
 * Idempotency: the webhook route already de-duplicates via
 * `email_delivery_events.svix_id UNIQUE` (F1 email infrastructure,
 * migration 0106); duplicate events would increment counters twice
 * if reached here. Caller MUST gate via the svix-id idempotency
 * check upstream.
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
}

export interface ApplyBatchWebhookEventInput {
  readonly tenantId: string;
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly broadcastId: string;
  readonly eventType: BatchWebhookEventType;
  readonly recipientEmailHashed: string;
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

  return ok(undefined);
}
