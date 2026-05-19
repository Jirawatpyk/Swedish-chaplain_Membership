/**
 * Phase 3F.11.15 (Round 3 Type Bottom #6) — IdempotencyKey brand.
 *
 * F7.1a US1 per-batch idempotency keys MUST follow the format
 * `broadcast-{uuid}-batch-{i}-attempt-{a}` with `-autoretry-{n}` or
 * `-manualretry-{n}` suffixes on retry paths. Pre-brand, the type
 * was bare `string` — a future contributor could pass any string
 * (e.g. a random UUID without the namespace prefix) to the Resend
 * `sendBroadcast(broadcastId, idempotencyKey)` call and the deduper
 * would either short-circuit randomly or fail to short-circuit on
 * actual retries.
 *
 * The brand makes the IdempotencyKey nominally-typed at the API
 * boundary (Resend gateway + BatchManifestsPort) so the ONLY way to
 * obtain one is through the constructor functions in this file:
 *   - `makeIdempotencyKey(broadcastId, batchIndex, attempt)` — base
 *     key produced by split-broadcast-into-batches.ts
 *   - `rotateForAutoRetry(key, retryCount)` — Phase 3F.1 F-04 fix at
 *     auto-retry-failed-batches.ts
 *   - `rotateForManualRetry(key, retryAttempt)` — Phase 3F.11.1 C2 at
 *     retry-failed-batches.ts
 *   - `asIdempotencyKey(raw)` — repo-adapter boundary hatch when
 *     re-hydrating a `BatchManifest` from a DB row (Drizzle returns
 *     strings, not branded types — this is the documented escape
 *     point for that direction)
 *
 * Namespaces:
 *   - `-autoretry-N` (sweep retry, T056)
 *   - `-manualretry-N` (admin retry, T047 — disjoint per Phase 3F.11.1 C2)
 *
 * Pure Domain — no framework / no Infrastructure imports.
 */
import type { BroadcastId } from '../broadcast';

declare const idempotencyKeyBrand: unique symbol;

/**
 * A nominally-typed Resend-compatible idempotency key for a single
 * broadcast batch. Carries the format `broadcast-{uuid}-batch-{i}-
 * attempt-{a}` with optional `-autoretry-{n}` or `-manualretry-{n}`
 * suffixes. Treat as opaque at consumer sites — never interpolate
 * with string concatenation outside this file.
 */
export type IdempotencyKey = string & { readonly [idempotencyKeyBrand]: true };

/**
 * Construct the canonical idempotency key for batch `batchIndex` of
 * `broadcastId` on attempt `attempt` (always 0 in F7.1a US1 — the
 * single attempt counter increments via rotation functions below).
 */
export function makeIdempotencyKey(
  broadcastId: BroadcastId,
  batchIndex: number,
  attempt: number,
): IdempotencyKey {
  return `broadcast-${broadcastId}-batch-${batchIndex}-attempt-${attempt}` as IdempotencyKey;
}

/**
 * Rotate the key for an auto-retry attempt. Appends `-autoretry-{n}`
 * to defeat Resend's deduper (Phase 3F.1 F-04 fix). Disjoint from
 * manual-retry namespace below — sweep and admin retries never
 * collide on the same batch.
 *
 * @param baseKey  The existing batch's `idempotencyKey` (preserved
 *                 verbatim — no parsing/re-construction).
 * @param newRetryCount  The post-increment retry count (1-based).
 */
export function rotateForAutoRetry(
  baseKey: IdempotencyKey,
  newRetryCount: number,
): IdempotencyKey {
  return `${baseKey}-autoretry-${newRetryCount}` as IdempotencyKey;
}

/**
 * Rotate the key for a manual-retry attempt. Appends
 * `-manualretry-{n}` (disjoint from `-autoretry-`). Phase 3F.11.1 C2.
 *
 * @param baseKey  The existing batch's `idempotencyKey` (preserved
 *                 verbatim).
 * @param retryAttempt  The 1-based manual retry attempt number (from
 *                      `BroadcastsRetryRepo.incrementManualRetryCount`).
 */
export function rotateForManualRetry(
  baseKey: IdempotencyKey,
  retryAttempt: number,
): IdempotencyKey {
  return `${baseKey}-manualretry-${retryAttempt}` as IdempotencyKey;
}

/**
 * Boundary cast for Infrastructure → Domain rehydration. Drizzle
 * returns plain strings from DB rows; the adapter brand them here
 * when constructing a `BatchManifest` aggregate. This is the SOLE
 * documented escape from the brand barrier in the inbound direction.
 *
 * Caller invariant: the input MUST have been written by one of the
 * three constructor functions above. The brand carries no runtime
 * validation — adapters trust their own writes.
 */
export function asIdempotencyKey(raw: string): IdempotencyKey {
  return raw as IdempotencyKey;
}
