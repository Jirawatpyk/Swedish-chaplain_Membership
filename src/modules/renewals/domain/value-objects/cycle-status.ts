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
  upcoming: ['reminded', 'awaiting_payment', 'cancelled'],
  reminded: ['awaiting_payment', 'cancelled'],
  awaiting_payment: [
    'completed',
    'lapsed',
    'pending_admin_reactivation',
    'cancelled',
  ],
  pending_admin_reactivation: ['completed', 'cancelled'],
  // Lapsed members can re-enter the cycle when they pay — branches per
  // member.blocked_from_auto_reactivation flag (FR-005b).
  lapsed: ['awaiting_payment', 'pending_admin_reactivation'],
  // Terminal — no outbound transitions.
  completed: [],
  cancelled: [],
};

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
