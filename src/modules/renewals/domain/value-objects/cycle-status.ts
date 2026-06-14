/**
 * T031 (F8 Phase 2 Wave D) — `CycleStatus` Domain value object.
 *
 * 7-state machine for `renewal_cycles.status` (data-model.md § 2.1
 * state diagram L83–126; extended at /speckit.clarify Q1 round 3 +
 * /speckit.critique round 2 / M3 with `pending_admin_reactivation`).
 *
 * Domain owns:
 *   - canonical state list + parser
 *   - transition policy (`canTransition` / `assertCanTransition`)
 *   - terminal-state predicate
 *
 * Infrastructure mirrors the same set via the `renewal_cycles_status_check`
 * CHECK constraint in migration 0087.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

export const CYCLE_STATUSES = [
  'upcoming',
  'reminded',
  'awaiting_payment',
  'completed',
  'lapsed',
  'cancelled',
  'pending_admin_reactivation',
] as const;

export type CycleStatus = (typeof CYCLE_STATUSES)[number];

/**
 * K7: compile-time count assertion — accidentally adding/dropping a
 * status from the const tuple is now a build error rather than a
 * silent runtime change. Mirrors the pattern in
 * renewal-audit-emitter.ts (`_AssertF8AuditEventCount`) and
 * dispatch-one-cycle.ts (`_AssertSkipReasonCount`).
 */
type _AssertCycleStatusCount = (typeof CYCLE_STATUSES)['length'] extends 7
  ? true
  : 'CYCLE_STATUSES count mismatch — expected 7';
const _assertCycleStatusCount: _AssertCycleStatusCount = true;
void _assertCycleStatusCount;

export const TERMINAL_CYCLE_STATUSES = [
  'completed',
  'lapsed',
  'cancelled',
] as const satisfies readonly CycleStatus[];

export type TerminalCycleStatus = (typeof TERMINAL_CYCLE_STATUSES)[number];

export type CycleStatusError = {
  readonly kind: 'invalid_cycle_status';
  readonly raw: string;
};

export function asCycleStatus(raw: string): CycleStatus {
  return raw as CycleStatus;
}

export function parseCycleStatus(
  raw: string,
): Result<CycleStatus, CycleStatusError> {
  if ((CYCLE_STATUSES as readonly string[]).includes(raw)) {
    return ok(raw as CycleStatus);
  }
  return err({ kind: 'invalid_cycle_status', raw });
}

export function isTerminalCycleStatus(
  status: CycleStatus,
): status is TerminalCycleStatus {
  return (TERMINAL_CYCLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Allowed transitions (data-model.md § 2.1 state diagram). Admin "cancel
 * from any non-terminal state" is encoded as a wildcard sink to
 * `cancelled` from every non-terminal source.
 *
 * The map is INTENTIONALLY exhaustive at the type level — every
 * `CycleStatus` key has a value (possibly empty array). New states
 * added via /speckit.clarify or /speckit.critique should land here in
 * the same patch as the constant tuple update.
 */
const TRANSITIONS: Record<CycleStatus, readonly CycleStatus[]> = {
  // +completed: offline-mark of an `upcoming` cycle via mark-paid-offline.ts
  // (its PAYABLE_STATUSES = {awaiting_payment, upcoming}) flips straight to
  // `completed` without first passing through `awaiting_payment`.
  upcoming: ['reminded', 'awaiting_payment', 'completed', 'cancelled'],
  reminded: ['awaiting_payment', 'cancelled'],
  awaiting_payment: [
    'completed',
    'lapsed',
    'pending_admin_reactivation',
    'cancelled',
  ],
  // +lapsed: a money-hold that times out (reconcile-pending-reactivations.ts)
  // passively expires to `lapsed` — distinct from an explicit admin reject
  // (→ `cancelled`). See the terminal-state divergence note below.
  pending_admin_reactivation: ['completed', 'cancelled', 'lapsed'],
  // Lapsed members can re-enter the cycle when they pay — branches per
  // member.blocked_from_auto_reactivation flag (FR-005b).
  lapsed: ['awaiting_payment', 'pending_admin_reactivation'],
  // Terminal — no outbound transitions.
  completed: [],
  cancelled: [],
};

/**
 * Terminal-state divergence (INTENTIONAL — do NOT converge).
 *
 * Two paths leave `pending_admin_reactivation`, and they MUST land in
 * different terminal states:
 *   - admin REJECT (explicit refusal, admin-reject-reactivation.ts)
 *     → `cancelled`. The member was actively declined; they LEAVE the
 *     re-engagement funnel.
 *   - reconcile TIMEOUT (30-day passive expiry with no admin action,
 *     reconcile-pending-reactivations.ts) → `lapsed`. The member simply
 *     never got reviewed; they STAY in the at-risk / lapsed re-engagement
 *     funnel for follow-up.
 *
 * Converging these (routing both to `lapsed`, or both to `cancelled`) would
 * silently shift members between the at-risk and lapsed reporting buckets:
 * the `URGENCY_CASE_SQL` expression in `drizzle-renewal-cycle-repo.ts`
 * short-circuits the urgency computation on `status = 'lapsed'`, and the
 * admin lapsed-tab + at-risk funnel bucket members by these terminal states.
 * The split is a reporting invariant, not an accident — keep
 * `reject → cancelled` and `timeout → lapsed` distinct.
 */

export function canTransition(from: CycleStatus, to: CycleStatus): boolean {
  return (TRANSITIONS[from] as readonly string[]).includes(to);
}

export type CycleTransitionError = {
  readonly kind: 'invalid_transition';
  readonly from: CycleStatus;
  readonly to: CycleStatus;
};

export function assertCanTransition(
  from: CycleStatus,
  to: CycleStatus,
): Result<void, CycleTransitionError> {
  if (canTransition(from, to)) return ok(undefined);
  return err({ kind: 'invalid_transition', from, to });
}

/**
 * Thrown by the Infrastructure `transitionStatus` adapter when an
 * undeclared `(from → to)` edge is attempted — a defence-in-depth domain
 * guard that runs BEFORE the optimistic CAS (`WHERE status = from`). A
 * legal-but-stale edge still surfaces a `CycleTransitionConflictError`
 * from the CAS; an ILLEGAL edge (not in `TRANSITIONS`) fails fast here so
 * the map stays the single source of truth for what a writer may do.
 *
 * Co-located with `assertCanTransition` (the Result-returning policy) so
 * the throwing wrapper and the policy it enforces live together. The
 * sibling `CycleNotFoundError` / `CycleTransitionConflictError` live in
 * the `renewal-cycle-repo` port (CAS/probe outcomes); this is a pure
 * domain-edge violation and belongs with the transition policy.
 */
export class InvalidCycleTransitionError extends Error {
  constructor(
    readonly from: CycleStatus,
    readonly to: CycleStatus,
  ) {
    super(`Invalid cycle transition: ${from} → ${to} is not a declared edge`);
    this.name = 'InvalidCycleTransitionError';
  }
}
