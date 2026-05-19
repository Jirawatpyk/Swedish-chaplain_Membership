/**
 * T047/T048 (F7.1a US1) — `BroadcastsRetryRepo` Application port.
 *
 * Narrow port (Interface-Segregation Principle) for the 3 retry-loop
 * persistence operations introduced by F7.1a US1:
 *   - `findById` — read the broadcast row's status + manual_retry_count
 *   - `incrementManualRetryCount` — atomic UPDATE ... SET count+1
 *     WHERE count < 3 (DB CHECK constraint enforces the budget;
 *     adapter returns `check_violation` on rejection)
 *   - `acceptPartial` — state transition `partially_sent →
 *     partial_delivery_accepted` (terminal) + persist accepted_at +
 *     by_user_id
 *
 * Kept separate from the broader `BroadcastsRepo` to avoid forcing
 * every existing implementation (the F7 MVP DrizzleBroadcastsRepo +
 * test fixtures) to implement these new methods. The Drizzle adapter
 * (Phase 3B.3) can implement BOTH ports on the same class so the
 * production wiring stays single-row.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { BroadcastId } from '../../domain/broadcast';

export type BroadcastRetryStatus =
  | 'draft'
  | 'pending_review'
  | 'approved'
  | 'sending'
  | 'partially_sent'
  | 'partial_delivery_accepted'
  | 'sent'
  | 'failed_to_dispatch'
  | 'cancelled'
  | 'rejected';

export interface BroadcastRetrySnapshot {
  readonly tenantId: string;
  readonly broadcastId: BroadcastId;
  readonly status: BroadcastRetryStatus;
  readonly manualRetryCount: number;
}

export type IncrementError =
  | { readonly kind: 'check_violation' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export type AcceptPartialError =
  | { readonly kind: 'INVALID_STATE_TRANSITION' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'storage_error'; readonly detail: string };

export interface AcceptPartialInput {
  readonly acceptedAt: Date;
  readonly acceptedByUserId: string;
}

export interface BroadcastsRetryRepo {
  /**
   * Read the broadcast row's retry-relevant snapshot. Returns `null`
   * if the row doesn't exist OR is hidden by RLS (cross-tenant).
   * Callers SHOULD emit `broadcast_cross_tenant_probe` audit on null.
   *
   * Caller passes the tenant context's `slug` string. The Drizzle
   * adapter runs the SELECT inside `runInTenant(slug, ...)` so RLS
   * confines visibility to the matching tenant.
   */
  findById(
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<BroadcastRetrySnapshot | null>;

  /**
   * Atomic `UPDATE broadcasts SET manual_retry_count = manual_retry_count + 1
   * WHERE id = $broadcastId AND manual_retry_count < 3 RETURNING
   * manual_retry_count`. On `0 rows updated` the budget was already
   * exhausted — return `check_violation`.
   */
  incrementManualRetryCount(
    tenantId: string,
    broadcastId: BroadcastId,
  ): Promise<Result<number, IncrementError>>;

  /**
   * Atomic state transition `partially_sent → partial_delivery_accepted`
   * + persist `partial_delivery_accepted_at` + `..._by_user_id`. The
   * Drizzle adapter uses `WHERE status = 'partially_sent'` so
   * concurrent retries cannot bypass the terminal-state guard
   * (returns `INVALID_STATE_TRANSITION` on 0 rows updated).
   */
  acceptPartial(
    tenantId: string,
    broadcastId: BroadcastId,
    input: AcceptPartialInput,
  ): Promise<Result<{ acceptedAt: Date }, AcceptPartialError>>;
}
