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
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import type { TxToken } from './advisory-lock-port';

/**
 * Phase 3F.1 (2026-05-19) — replaced local `BroadcastRetryStatus`
 * union (which had a stale `'pending_review'` value never present
 * in the canonical `BROADCAST_STATUSES` Domain tuple) with the
 * authoritative `BroadcastStatus` import. Single source of truth;
 * future status additions automatically flow through.
 */
export type BroadcastRetryStatus = BroadcastStatus;

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
   * Phase 3E hardening — opens a tx for atomic retry orchestration.
   * T047 wraps its entire body in `withTx` so the advisory lock +
   * snapshot read + increment + batch fan-out + audit emit all share
   * one tx. Lock auto-releases at commit; rollback on uncaught error
   * also releases.
   *
   * Drizzle impl: `runInTenant(ctx, async tx => fn(asTxToken(tx)))`.
   *
   * Phase 3F.11.11 (Round 3 TxToken Step 2) — callback receives a
   * branded `TxToken` instead of `unknown`. This eliminates the
   * `asTxToken(tx)` brand-laundering line at use-case call sites
   * (e.g. retry-failed-batches.ts:advisoryLock.acquire was wrapping
   * `tx` via `asTxToken(tx)` since 3F.11.6 Step 1; tx now arrives
   * pre-branded). Adapter casts at the boundary only.
   */
  withTx<T>(fn: (tx: TxToken) => Promise<T>): Promise<T>;

  /**
   * Read the broadcast row's retry-relevant snapshot. Returns `null`
   * if the row doesn't exist OR is hidden by RLS (cross-tenant).
   * Callers SHOULD emit `broadcast_cross_tenant_probe` audit on null.
   *
   * Caller passes the tenant context's `slug` string. The Drizzle
   * adapter runs the SELECT inside `runInTenant(slug, ...)` so RLS
   * confines visibility to the matching tenant.
   *
   * Trailing optional `tx` — when provided, reuses the caller's tx
   * (Phase 3E withTx pattern); when omitted, opens own runInTenant.
   * Test stubs that ignore tx satisfy this signature via TS structural
   * trailing-optional rule.
   */
  findById(
    tenantId: string,
    broadcastId: BroadcastId,
    tx?: unknown,
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
    tx?: unknown,
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
