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
  );

  if (!result.ok) {
    if (result.error.kind === 'not_found') {
      // Phase 3F.7 (F-23 fix) — emit a forensic audit on the not-found
      // race path. BYPASSRLS lookup just resolved the tenantId, then
      // the increment found 0 rows → either the batch was force-deleted
      // between the two queries (admin ops action) OR the lookup
      // returned a stale tenant (impossible under current schema but
      // future-proof). Either way, forensic trail matters.
      try {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          eventType: 'broadcast_cross_tenant_probe',
          actorUserId: 'system:resend-webhook',
          summary: `Webhook event for missing batch ${input.batchManifestId} (race window)`,
          payload: {
            broadcastId: input.broadcastId,
            batchManifestId: input.batchManifestId,
            batchIndex: input.batchIndex,
            eventType: input.eventType,
            resendEventId: input.resendEventId,
            useCase: 'apply-batch-webhook-event',
          },
          requestId: input.requestId ?? null,
        });
      } catch {
        // best-effort
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

  // Audit emit — reuse `broadcast_delivery_recorded` event (added in
  // F7 MVP R6 staff-review) with `batchIndex` in payload for the
  // F71A surface. Same event type so the F9 audit-viewer doesn't
  // need a new filter; payload distinguishes broadcast-level vs
  // batch-level via presence/absence of `batchManifestId`.
  // Phase 3F.1 (F-6 silent-fail fix) — wrap audit emit in try/catch
  // so an audit-port outage AFTER the counter increment doesn't
  // propagate to the webhook route's 500 path. A 500 → Svix retries
  // the webhook → the idempotent `incrementCounter` would increment
  // AGAIN → double-counted delivered/bounced/etc. The counter
  // increment is the truth-of-record; the audit is observability.
  // Log on failure (operator alerts on the rate) + return ok so the
  // webhook returns 200 + Svix moves on.
  try {
    await deps.audit.emit(null, {
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
  } catch (auditErr) {
    logger.error(
      {
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        tenantId: input.tenantId,
        batchManifestId: input.batchManifestId,
        broadcastId: input.broadcastId,
        eventType: input.eventType,
      },
      'broadcasts.batch.apply_webhook_audit_failed',
    );
  }

  return ok(undefined);
}
