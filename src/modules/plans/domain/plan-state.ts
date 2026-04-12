/**
 * Plan state machine — encodes the lifecycle rules from data-model.md § 2.1.
 *
 * Logical states (not stored as a single column — derived from
 * `is_active` + `deleted_at`):
 *
 *   - `active`       — `is_active = true  AND deleted_at IS NULL`
 *   - `inactive`     — `is_active = false AND deleted_at IS NULL`
 *   - `soft_deleted` — `deleted_at IS NOT NULL`  (is_active is irrelevant)
 *
 * Transitions:
 *
 *   active     → inactive     (deactivate)
 *   inactive   → active       (activate)
 *   inactive   → soft_deleted (delete — requires zero active members)
 *   soft_deleted → inactive   (undelete — forces is_active = false per US4 AS4)
 *
 * Illegal transitions:
 *   - active → soft_deleted (must deactivate first)
 *   - soft_deleted → active (must undelete to inactive first, then activate)
 *
 * Pure TypeScript — no framework imports.
 */

export type PlanState = 'active' | 'inactive' | 'soft_deleted';

export type PlanStateSnapshot = {
  readonly is_active: boolean;
  readonly deleted_at: Date | null;
};

/** Derive the logical state from a plan's is_active + deleted_at columns. */
export function planStateOf(snapshot: PlanStateSnapshot): PlanState {
  if (snapshot.deleted_at !== null) return 'soft_deleted';
  return snapshot.is_active ? 'active' : 'inactive';
}

// --- Result type --------------------------------------------------------------

export type TransitionOk = { ok: true };
export type TransitionErr =
  | { ok: false; reason: 'illegal_transition'; from: PlanState; to: PlanState }
  | { ok: false; reason: 'active_members_attached'; count: number };

export type TransitionResult = TransitionOk | TransitionErr;

export type CanTransitionContext = {
  /** For `soft_delete` — number of active members currently on this plan. */
  readonly activeMemberCount?: number;
};

// --- Transition rules ---------------------------------------------------------

/**
 * Can the plan transition from `from` to `to`?
 *
 *   canTransition('active', 'inactive')                       → ok
 *   canTransition('inactive', 'active')                       → ok
 *   canTransition('inactive', 'soft_deleted', {members: 0})   → ok
 *   canTransition('inactive', 'soft_deleted', {members: 3})   → err
 *   canTransition('soft_deleted', 'inactive')                 → ok (undelete)
 *   canTransition('active', 'soft_deleted')                   → err (must deactivate first)
 *   canTransition('soft_deleted', 'active')                   → err (no direct path)
 */
export function canTransition(
  from: PlanState,
  to: PlanState,
  ctx: CanTransitionContext = {},
): TransitionResult {
  // No-op is always fine (idempotent)
  if (from === to) return { ok: true };

  // active ↔ inactive
  if (from === 'active' && to === 'inactive') return { ok: true };
  if (from === 'inactive' && to === 'active') return { ok: true };

  // inactive → soft_deleted (member-count gated)
  if (from === 'inactive' && to === 'soft_deleted') {
    const count = ctx.activeMemberCount ?? 0;
    if (count > 0) {
      return { ok: false, reason: 'active_members_attached', count };
    }
    return { ok: true };
  }

  // soft_deleted → inactive (undelete)
  if (from === 'soft_deleted' && to === 'inactive') return { ok: true };

  // Everything else is illegal
  return { ok: false, reason: 'illegal_transition', from, to };
}
