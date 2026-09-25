/**
 * T026 — Broadcast state-machine transition policy (F7).
 *
 * Enforces the FR-004 + FR-004a state machine at the Domain layer.
 * Defence-in-depth pairs with the DB-level state-machine trigger
 * (data-model.md § 4.2). Both layers MUST agree — if they drift, the
 * Drizzle constraint will fire AFTER the Application's `transition()`
 * has run, surfacing as a ServerError instead of a clean Result.
 *
 * State machine (8 states; 4 terminal):
 *
 *   draft ──submit──> submitted ──approve──> approved ──send-now/cron──> sending
 *                          │                     │                          │
 *                          │                     │                          ├──ack──> sent (TERMINAL)
 *                          │                     │                          └──fail──> failed_to_dispatch (TERMINAL)
 *                          ├──reject──> rejected (TERMINAL)
 *                          ├──cancel──> cancelled (TERMINAL)        Q10: cancellable
 *                          │                     ├──cancel──> cancelled (TERMINAL)  in submitted/approved only
 *
 * Terminal states (sent, rejected, cancelled, failed_to_dispatch) have
 * empty outbound adjacency lists.
 *
 * F119 adds the approval round (data-model § 8.2): submitted/approved →
 * in_design → awaiting_member_approval → member_approved | changes_requested,
 * member_approved → approved (confirm schedule), and the terminal
 * expired_no_member_response, reachable only from awaiting_member_approval.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import {
  type BroadcastStatus,
  isTerminalStatus,
} from '../value-objects/broadcast-status';

/**
 * Adjacency list — for each `from` state, the set of legal `to` states.
 * Terminal states map to an empty array.
 */
const TRANSITIONS: Readonly<Record<BroadcastStatus, ReadonlyArray<BroadcastStatus>>> = {
  draft: ['submitted'],
  // F119 (0308, data-model § 8.2) — every arm that touches one of the five
  // new statuses is identical to `broadcasts_state_machine_fn`; T037 probes
  // each pair at the DB and here. `approved → failed_to_dispatch` stays a
  // trigger-only edge (a recorded pre-existing divergence, out of scope).
  // The Application adds guards on top: `submitted → in_design` needs the
  // flag, `approved → in_design | changes_requested` needs round ≥ 1.
  submitted: ['approved', 'rejected', 'cancelled', 'in_design'],
  approved: ['sending', 'cancelled', 'changes_requested', 'in_design'],
  // F7.1a US1 — `sending` can also progress to `partially_sent`
  // (FR-008a: ≥1 batch reached failed after per-batch retry budget
  // exhausted). The legacy `sent`/`failed_to_dispatch` edges stay
  // for the all-success / all-fail paths.
  sending: ['sent', 'failed_to_dispatch', 'partially_sent'],
  sent: [],
  rejected: [],
  cancelled: [],
  failed_to_dispatch: [],
  // F7.1a US1 — `partially_sent` is NON-terminal. Two outbound edges:
  //   - back to `sending` on admin "Retry failed batches" action
  //     (bumps manual_retry_count to ≤3 first; Application checks the
  //     CHECK before attempting transition)
  //   - to `partial_delivery_accepted` (TERMINAL) on admin
  //     "Accept partial delivery" action
  partially_sent: ['sending', 'partial_delivery_accepted'],
  partial_delivery_accepted: [],
  in_design: ['awaiting_member_approval', 'rejected', 'cancelled'],
  awaiting_member_approval: [
    'member_approved',
    'changes_requested',
    'rejected',
    'cancelled',
    'expired_no_member_response',
  ],
  changes_requested: ['in_design', 'rejected', 'cancelled'],
  member_approved: ['approved', 'changes_requested', 'in_design', 'rejected', 'cancelled'],
  // TERMINAL (FR-022a) — no closed stage can be reopened.
  expired_no_member_response: [],
};

export type BroadcastTransitionError =
  | {
      readonly code: 'broadcast_status.invalid_transition';
      readonly from: BroadcastStatus;
      readonly to: BroadcastStatus;
    }
  | {
      readonly code: 'broadcast_status.terminal_state';
      readonly status: BroadcastStatus;
    };

/**
 * Pure boolean predicate: is `from → to` legal? Used by Application
 * use-cases for early validation before opening a transaction. Falls
 * out of `transition()`'s logic but exposed separately for cheap
 * pre-check call sites (e.g. UI button disabled-state).
 */
export function canTransition(
  from: BroadcastStatus,
  to: BroadcastStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validate a state transition. Returns the target status on success
 * (caller persists). Returns a discriminated error on failure so the
 * caller can surface the correct audit code:
 *   - `broadcast_status.terminal_state` — the broadcast is already in
 *     a terminal state; the action (cancel/approve/etc.) is too late
 *     and must be rejected with HTTP 409 + the corresponding audit
 *     event (`broadcast_cancel_too_late`, etc.)
 *   - `broadcast_status.invalid_transition` — the target is unreachable
 *     from the current state; programmer error or stale UI state
 */
export function transition(
  from: BroadcastStatus,
  to: BroadcastStatus,
): Result<BroadcastStatus, BroadcastTransitionError> {
  if (isTerminalStatus(from)) {
    return err({ code: 'broadcast_status.terminal_state', status: from });
  }
  if (!canTransition(from, to)) {
    return err({ code: 'broadcast_status.invalid_transition', from, to });
  }
  return ok(to);
}

/**
 * Read-only export of the adjacency table for tests + observability
 * (e.g. dashboard rendering of "what transitions exist?").
 */
export const BROADCAST_TRANSITIONS = TRANSITIONS;
