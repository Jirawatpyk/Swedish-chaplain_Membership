/**
 * T024 (F7.1a US1) — `BatchManifestsPort` Application port.
 *
 * Per-batch tracking for broadcasts that split across multiple
 * Resend audiences (>10k recipients hit the per-audience cap;
 * FR-001 lifts the broadcast ceiling 5k → 50k). The Drizzle adapter
 * (T029 `drizzle-batch-manifests-repo.ts`) runs inside `runInTenant()`
 * so RLS+FORCE (migration 0166) is the storage-layer guard. Each
 * batch is identified by `(tenant_id, broadcast_id, batch_index)`
 * (unique index in migration 0163).
 *
 * Advisory-lock contract (plan.md § VIII Reliability, FR-002): the
 * `dispatchBroadcastBatch` use case (Phase 3 T045) attempts
 * `pg_try_advisory_xact_lock('broadcasts-batch:' || tenantId || ':' ||
 * broadcastId || ':' || batchIndex)` BEFORE invoking the gateway, to
 * serialise concurrent retries against the same batch. Note: T045
 * wires `noOpAdvisoryLock` in production (see `noop-advisory-lock.ts`
 * header for the long-running-gateway-call rationale); per-batch
 * race is mitigated by cron-job.org tick spacing + FOR UPDATE SKIP
 * LOCKED in T055 eligible scan + idempotency-key unique index. This port's
 * implementations MUST NOT acquire the lock — that's the use case's
 * responsibility (so transaction boundaries align with the lock
 * lifetime).
 *
 * State machine (enforced in `drizzle-batch-manifests-repo.ts`
 * ALLOWED_TRANSITIONS map; migration 0163 CHECK enforces value
 * membership only, NOT transitions):
 *   pending → sending → sent | failed
 *   failed → pending    (retryFailedBatches re-queues; idempotency
 *                        key rotated per Phase 3F.1 fix F-04)
 *   pending → cancelled (set by cancelBroadcast Phase 3 T163 when
 *                        admin halts mid-dispatch per FR-004;
 *                        per data-model § 2.2 N1)
 *
 * Pure interface — no framework imports (Constitution Principle III
 * NON-NEGOTIABLE).
 */

import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants';
import type { BroadcastId } from '../../domain/broadcast';
import type { IdempotencyKey } from '../../domain/value-objects/idempotency-key';
import type { TxToken } from './advisory-lock-port';

export type BatchStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';

export interface BatchManifest {
  readonly id: string; // uuid
  readonly tenantId: TenantSlug;
  readonly broadcastId: BroadcastId;
  readonly batchIndex: number;
  readonly recipientCount: number;
  readonly recipientRangeStart: number;
  readonly recipientRangeEnd: number;
  readonly status: BatchStatus;
  readonly providerAudienceId: string | null;
  /**
   * Resend broadcast resource id (from `gateway.createBroadcast`).
   * NULL until `dispatchBroadcastBatch` (T045) reaches the
   * `createBroadcast` stage. Used by the webhook handler (T057) to
   * route per-batch `email.*` events back to the correct manifest.
   */
  readonly providerBroadcastId: string | null;
  // Phase 3F.11.15 (Type Bottom #6) — branded type. The DB stores
  // plain strings; adapters brand via `asIdempotencyKey(row.idempotency_key)`
  // when constructing a `BatchManifest`. Use cases must use the
  // Domain factory functions (makeIdempotencyKey, rotateForAutoRetry,
  // rotateForManualRetry) to construct or rotate keys.
  readonly idempotencyKey: IdempotencyKey;
  readonly retryCount: number;
  readonly deliveredCount: number;
  readonly bouncedCount: number;
  readonly complainedCount: number;
  readonly unsubscribedCount: number;
  readonly dispatchedAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewBatchManifestInput {
  readonly broadcastId: BroadcastId;
  readonly batchIndex: number;
  readonly recipientCount: number;
  readonly recipientRangeStart: number;
  readonly recipientRangeEnd: number;
  /**
   * Idempotency key format per plan.md § VIII (Reliability):
   *   `broadcast-{broadcastId}-batch-{batchIndex}-attempt-{retryCount}`
   * On auto-retry path (T056), key is rotated to
   *   `broadcast-{broadcastId}-batch-{batchIndex}-attempt-0-autoretry-{retryCount}`
   * so Resend's deduper doesn't short-circuit retried dispatches
   * (Phase 3F.1 F-04 fix).
   */
  readonly idempotencyKey: IdempotencyKey;
}

export type BatchInsertError =
  | { readonly kind: 'duplicate_batch_index' }
  | { readonly kind: 'duplicate_idempotency_key' }
  | { readonly kind: 'invalid_recipient_range'; readonly detail: string }
  | { readonly kind: 'storage_error'; readonly detail: string };

export type BatchUpdateError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'invalid_state_transition'; readonly from: BatchStatus; readonly to: BatchStatus }
  | { readonly kind: 'storage_error'; readonly detail: string };

export interface BatchStatusUpdate {
  readonly status: BatchStatus;
  readonly providerAudienceId?: string;
  readonly providerBroadcastId?: string;
  readonly dispatchedAt?: Date;
  readonly failedAt?: Date;
  readonly failureReason?: string;
  readonly retryCount?: number;
  /**
   * Phase 3F.1 (F-04 fix) — idempotency-key rotation on auto-retry.
   * Auto-retry flips `failed → pending` and bumps `retry_count`; if
   * the idempotency key stays the same, Resend's deduper would
   * silently drop the resent broadcast → recipients never receive
   * the email → 5-attempt auto-retry budget becomes 5 no-ops.
   *
   * Format: `broadcast-{uuid}-batch-{i}-attempt-{a}-autoretry-{n}`
   * where `n` = the post-bump `retry_count` value.
   *
   * Phase 3F.11.15 (Type Bottom #6) — branded type. Use
   * `rotateForAutoRetry` or `rotateForManualRetry` from
   * `domain/value-objects/idempotency-key.ts` to produce the value.
   */
  readonly idempotencyKey?: IdempotencyKey;
}

/**
 * Per-event counter delta — used by T057 webhook handler to increment
 * delivered / bounced / complained / unsubscribed on the batch row
 * atomically. The adapter applies the delta via
 *   UPDATE … SET {column} = {column} + 1, updated_at = now()
 *   WHERE tenant_id = $ AND id = $
 * Only one field set per call (mutually exclusive Resend event types).
 */
export type BatchCounterField =
  | 'deliveredCount'
  | 'bouncedCount'
  | 'complainedCount'
  | 'unsubscribedCount';

export type BatchCounterIncrementError =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

/**
 * Cross-tenant lookup payload for T057 webhook routing. Returned by
 * `findBatchByProviderBroadcastIdBypassRls` — adapter reads with the
 * schema-owner role (BYPASSRLS) so the webhook can resolve tenant
 * context BEFORE binding `app.current_tenant`.
 */
export interface BatchProviderLookup {
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;
  readonly batchManifestId: string;
  readonly batchIndex: number;
  readonly recipientCount: number;
}

export interface BatchManifestsPort {
  /**
   * List all manifests for a broadcast (any status). Phase 3 T049
   * admin broadcast detail page reads via this for the per-batch
   * breakdown collapsible.
   */
  findByBroadcast(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    /**
     * Phase 3E hardening — when provided, reuses the caller's tx so
     * the read participates in the same lock-protected scope. Test
     * stubs ignoring `tx` satisfy this via TS structural trailing-
     * optional rule.
     */
    tx?: TxToken,
  ): Promise<readonly BatchManifest[]>;

  /**
   * Pending-only filter — Phase 3 T055 dispatch-batches cron scans
   * for rows older than 5 min that haven't transitioned to `sending`
   * yet, and Phase 3 T163 cancelBroadcast halts pending batches per
   * FR-004.
   */
  findPendingByBroadcast(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
  ): Promise<readonly BatchManifest[]>;

  /**
   * Insert multiple batch manifests in a single statement. Used by
   * Phase 3 T044 `splitBroadcastIntoBatches` use case after the
   * Domain batch-boundary calculator produces N rows. Atomic —
   * either all rows commit or none.
   */
  bulkInsert(
    tenantId: TenantSlug,
    inputs: readonly NewBatchManifestInput[],
  ): Promise<Result<readonly BatchManifest[], BatchInsertError>>;

  /**
   * Transition a single batch's status + optional metadata. Phase 3
   * T045 dispatch use case calls this after Resend ACK (success or
   * failure). State machine transitions are validated by Domain
   * (Phase 3 T043 batch-concurrency-policy) — port returns
   * `invalid_state_transition` if the requested transition is not in
   * the allowed graph.
   */
  updateStatus(
    tenantId: TenantSlug,
    batchManifestId: string,
    update: BatchStatusUpdate,
    tx?: TxToken,
  ): Promise<Result<BatchManifest, BatchUpdateError>>;

  /**
   * Bulk-cancel pending batches for FR-004 (admin halts mid-dispatch).
   * Phase 3 T163 cancelBroadcast calls this with the list of pending
   * manifest ids returned by `findPendingByBroadcast()`. Each row
   * transitions `pending → cancelled` atomically. Returns count of
   * rows marked.
   *
   * Phase 3F.1 (F-21 fix) — accepts optional `tx` so cancel-broadcast
   * can participate in the same atomic scope as its broadcast-row
   * UPDATE (eliminates the "batches halted but broadcast still sending"
   * inconsistency on subsequent throw).
   */
  markCancelled(
    tenantId: TenantSlug,
    batchManifestIds: readonly string[],
    tx?: TxToken,
  ): Promise<number>;

  /**
   * Increment a per-batch counter atomically (T057 webhook handler).
   * The Drizzle adapter runs:
   *   UPDATE broadcast_batch_manifests
   *   SET {column} = {column} + 1, updated_at = now()
   *   WHERE tenant_id = $1 AND id = $2
   * inside `runInTenant(ctx)` so RLS+FORCE confines visibility. Only
   * one counter field is incremented per call (mutually exclusive
   * Resend event types: delivered/bounced/complained/unsubscribed).
   *
   * Returns `not_found` if 0 rows updated (cross-tenant lookup race;
   * webhook handler logs + 200-OKs so Resend doesn't retry).
   *
   * F7-SF-1 — IDEMPOTENT on `resendEventId`. The adapter INSERTs the
   * event id into `broadcast_batch_delivery_events` ON CONFLICT DO
   * NOTHING in the SAME tx as the increment, so a Resend/Svix redelivery
   * of the same event returns `{ duplicate: true }` WITHOUT bumping the
   * counter again (mirrors the F7 MVP `upsertByResendEventId` dedup).
   */
  incrementCounter(
    tenantId: TenantSlug,
    batchManifestId: string,
    field: BatchCounterField,
    resendEventId: string,
  ): Promise<
    Result<{ readonly duplicate: boolean }, BatchCounterIncrementError>
  >;

  /**
   * Cross-broadcast scan for `auto-retry-failed-batches` use case
   * (Phase 3 T056, FR-005 — 5-attempt auto-retry budget). Returns
   * batches in `failed` state with `retry_count < retryBudget` whose
   * `failed_at` is older than `cooloffSeconds` (avoid rapid retry
   * storms after a transient Resend outage).
   *
   * Ordered by `failed_at ASC` (oldest first — fair queue).
   * Bounded by `limit` (cron handler caps per-tick fan-out).
   */
  findFailedRetryEligible(
    tenantId: TenantSlug,
    opts: {
      readonly retryBudget: number;
      readonly cooloffSeconds: number;
      readonly limit: number;
    },
  ): Promise<readonly BatchManifest[]>;

  /**
   * Cross-tenant lookup for T057 Resend webhook routing. Reads with
   * the schema-owner role (BYPASSRLS) — webhook arrives BEFORE
   * `app.current_tenant` is bound. Returns `null` for unknown ids
   * (legacy Resend dispatches from archived tenants OR misrouted
   * events from a leaked secret); caller logs + 200-OKs to prevent
   * Resend retry storm. Mirrors F7 MVP
   * `BroadcastsRepo.findByResendBroadcastIdBypassRls` pattern.
   */
  findBatchByProviderBroadcastIdBypassRls(
    providerBroadcastId: string,
  ): Promise<BatchProviderLookup | null>;
}
