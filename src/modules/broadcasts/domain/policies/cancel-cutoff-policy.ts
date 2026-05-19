/**
 * T026 — Cancellation cutoff policy (F7).
 *
 * Encodes Clarifications Q10 + FR-004a: a broadcast is cancellable only
 * while in `submitted` or `approved` state. Once dispatch has begun
 * (`sending`) the point of no return is the Resend Broadcasts API
 * acknowledgement — the email has left the building, so to speak.
 *
 * Cancel attempts on terminal states return HTTP 409 with audit code
 * `broadcast_cancel_too_late`. This policy is the Domain-layer source
 * of truth for that decision; Application + DB enforce the same rule
 * (defence in depth).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { BroadcastStatus } from '../value-objects/broadcast-status';

export type CancelCutoffError = {
  readonly code: 'broadcast_cancel_too_late';
  readonly status: BroadcastStatus;
};

/**
 * Pure boolean predicate: is the broadcast cancellable from this state?
 *
 * Phase 3F.1 (F-Finding-4 + F-21 fix 2026-05-19) — extended for F7.1a
 * US1 FR-004: when a broadcast is in `sending` state AND has split
 * batch_manifests, the cancel surface MUST halt the not-yet-dispatched
 * batches within ≤60s. Previously the `sending` status was always
 * cutoff (F7 MVP single-audience invariant: once Resend has the
 * payload, it can't be recalled). For F7.1a multi-batch broadcasts,
 * the dispatcher hasn't called Resend yet for `pending` rows — so
 * cancelling MID-dispatch IS recoverable for those pending rows.
 *
 * Caller passes `hasBatches` (true iff the broadcast was split into
 * ≥1 batch_manifest row — Phase 3 F71A US1 path). When false (F7 MVP
 * single-audience path), the original cutoff applies.
 *
 * Returns `true` for `submitted` | `approved` (unchanged) PLUS
 * `sending && hasBatches` (NEW). Returns `false` for everything else.
 */
export function canCancel(
  status: BroadcastStatus,
  hasBatches: boolean = false,
): boolean {
  if (status === 'submitted' || status === 'approved') return true;
  // F7.1a US1 widening — sending+batches is cancellable
  if (status === 'sending' && hasBatches) return true;
  return false;
}

/**
 * Validate a cancel attempt. Returns `ok(undefined)` if the cancel is
 * allowed (caller proceeds with state transition); returns a typed
 * error matching the `broadcast_cancel_too_late` audit code if the
 * status is past the cutoff.
 *
 * The `draft` case returns the same error code — drafts should be
 * deleted via the draft route, not cancelled. Surfacing the same
 * audit code here keeps the API contract uniform.
 *
 * Phase 3F.1 — `hasBatches` defaults to `false` for F7 MVP backward
 * compat. Callers in the F7.1a path (cancel-broadcast use case)
 * pass `true` after a successful `findPendingByBroadcast(...)`.
 */
export function authorizeCancel(
  status: BroadcastStatus,
  hasBatches: boolean = false,
): Result<true, CancelCutoffError> {
  if (canCancel(status, hasBatches)) return ok(true);
  return err({ code: 'broadcast_cancel_too_late', status });
}
