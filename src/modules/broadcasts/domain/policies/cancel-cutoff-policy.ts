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
 * `true` for `submitted` + `approved` only. `false` for everything
 * else (including the active draft state — drafts are deleted via
 * `DELETE /api/broadcasts/draft/[id]`, not cancelled).
 */
export function canCancel(status: BroadcastStatus): boolean {
  return status === 'submitted' || status === 'approved';
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
 */
export function authorizeCancel(
  status: BroadcastStatus,
): Result<true, CancelCutoffError> {
  if (canCancel(status)) return ok(true);
  return err({ code: 'broadcast_cancel_too_late', status });
}
