/**
 * Generic table-driven state-machine guard (review 2026-04-26 simplify R2).
 *
 * Eliminates the duplicated transition-guard scaffold previously
 * inlined in `payment-status-transitions.ts` and `refund.ts` —
 * both files implemented the same `terminal_state` /
 * `illegal_transition` discriminator with the same `allowed.length
 * === 0` and `allowed.includes(to)` checks.
 *
 * Each consumer declares its own `TStatus` literal union + transition
 * table, and the factory returns the matching `canTransition` +
 * `isLegalTransition` pair. The Application layer pairs these with
 * a Postgres row-level lock (`SELECT … FOR UPDATE`) to enforce
 * serialised state advances; this module owns only the *shape* of
 * legal transitions.
 *
 * Pure TypeScript — no framework/ORM imports.
 */

export type StateMachineError<TStatus extends string> =
  | { readonly kind: 'terminal_state'; readonly from: TStatus }
  | {
      readonly kind: 'illegal_transition';
      readonly from: TStatus;
      readonly to: TStatus;
    };

export interface StateMachine<TStatus extends string> {
  canTransition(
    from: TStatus,
    to: TStatus,
  ): { ok: true } | { ok: false; error: StateMachineError<TStatus> };
  isLegalTransition(from: TStatus, to: TStatus): boolean;
}

/**
 * Build a state-machine guard from a transition table.
 *
 * The table maps each source status to the set of legal destination
 * statuses. Empty arrays indicate terminal states; transitions out
 * of a terminal state surface as `kind: 'terminal_state'` so the
 * caller can distinguish "Stripe retry of an already-advanced row"
 * (idempotent no-op) from "structurally illegal transition"
 * (programmer / data-corruption signal).
 */
export function makeStateMachine<TStatus extends string>(
  table: Readonly<Record<TStatus, readonly TStatus[]>>,
): StateMachine<TStatus> {
  function canTransition(
    from: TStatus,
    to: TStatus,
  ): { ok: true } | { ok: false; error: StateMachineError<TStatus> } {
    const allowed = table[from];
    if (allowed.length === 0) {
      return { ok: false, error: { kind: 'terminal_state', from } };
    }
    if (!allowed.includes(to)) {
      return {
        ok: false,
        error: { kind: 'illegal_transition', from, to },
      };
    }
    return { ok: true };
  }

  function isLegalTransition(from: TStatus, to: TStatus): boolean {
    return canTransition(from, to).ok;
  }

  return { canTransition, isLegalTransition };
}
