/**
 * T026 — Cancellation cutoff policy (F7) · widened by F119 T081.
 *
 * A broadcast is cancellable (withdrawn by the member, cancelled by staff)
 * at ANY in-progress stage — `IN_PROGRESS_BROADCAST_STATUSES`, the one Domain
 * constant that also defines the allowance bucket and the erasure cascade
 * (FR-015, FR-020, data-model § 9). The cut-off is entry into `sending`: the
 * delivery provider has the E-Blast, so from `sending` onward the refusal is
 * `sending_started` and the send completes. A closed E-Blast that never
 * started sending (rejected, cancelled, expired, a failed dispatch) and a
 * draft keep the pre-existing `broadcast_cancel_too_late`.
 *
 * The F7.1a `sending`-with-batches arm is the operator path; it is kept as
 * it was and never extended to the member.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { hasSendingStarted, isInProgress } from '../stage/in-progress-statuses';
import type { BroadcastStatus } from '../value-objects/broadcast-status';

export type CancelCutoffError = {
  readonly code: 'broadcast_cancel_too_late' | 'sending_started';
  readonly status: BroadcastStatus;
};

/**
 * Pure boolean predicate: is the broadcast cancellable from this state?
 *
 * Phase 3F.1 (Finding 4 + F-21 fix 2026-05-19) — extended for F7.1a
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
 * Returns `true` for every in-progress status (F119 T081) PLUS
 * `sending && hasBatches` (NEW). Returns `false` for everything else.
 */
export function canCancel(
  status: BroadcastStatus,
  hasBatches: boolean = false,
): boolean {
  if (isInProgress(status)) return true;
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
  if (hasSendingStarted(status)) return err({ code: 'sending_started', status });
  return err({ code: 'broadcast_cancel_too_late', status });
}
