/**
 * T011-T012 (F8 Phase 2 Wave B) — Scheduled-plan-change Domain types.
 *
 * Pure TypeScript — no framework imports (Constitution Principle III).
 * Domain layer for the F2 cross-module table `scheduled_plan_changes`
 * (data-model.md § 2.9). The table itself ships in Wave C migration
 * 0086; the Drizzle adapter implementing `ScheduledPlanChangeRepo`
 * lands when US5 wires the F4 renewal-invoice-creation hook.
 *
 * Lifecycle (data-model.md § 2.9 state machine):
 *
 *     pending ──apply──→ applied   (terminal, F4 invoice paid)
 *     pending ──supersede──→ superseded (terminal, admin re-schedules)
 *     pending ──cancel──→ cancelled (terminal, admin explicit)
 *
 * No transitions out of terminal states. New `pending` rows may coexist
 * with prior terminal rows on the same (member, cycle) — the partial
 * unique on `(tenant_id, member_id, effective_at_cycle_id) WHERE
 * status='pending'` permits at most one pending per cycle but unlimited
 * terminal rows.
 */

/** All four state values. Terminal = anything other than `'pending'`. */
export const SCHEDULED_PLAN_CHANGE_STATUSES = [
  'pending',
  'applied',
  'superseded',
  'cancelled',
] as const;

export type ScheduledPlanChangeStatus =
  (typeof SCHEDULED_PLAN_CHANGE_STATUSES)[number];

/** True when the row may not transition further. */
export function isTerminalStatus(s: ScheduledPlanChangeStatus): boolean {
  return s !== 'pending';
}

/** Aggregate row shape — mirrors data-model.md § 2.9 columns 1:1. */
export interface ScheduledPlanChange {
  readonly tenantId: string;
  readonly scheduledChangeId: string;
  readonly memberId: string;
  readonly effectiveAtCycleId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly scheduledByUserId: string;
  readonly reason: string | null;
  readonly status: ScheduledPlanChangeStatus;
  /** ISO 8601 UTC. */
  readonly scheduledAt: string;
  /** ISO 8601 UTC; non-null iff status === 'applied'. */
  readonly appliedAt: string | null;
  /** ISO 8601 UTC; non-null iff status === 'superseded'. */
  readonly supersededAt: string | null;
  /** ISO 8601 UTC; non-null iff status === 'cancelled'. */
  readonly cancelledAt: string | null;
}

/** Caller-supplied fields when scheduling a NEW pending row. */
export interface ScheduleNextRenewalPlanChangeInput {
  readonly memberId: string;
  readonly effectiveAtCycleId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly scheduledByUserId: string;
  /** Optional free-form audit note (≤500 chars enforced in zod at API boundary). */
  readonly reason?: string;
}

export type ScheduleNextRenewalPlanChangeError =
  | { readonly code: 'invalid_input'; readonly field: string }
  | { readonly code: 'audit_failed'; readonly message: string }
  | { readonly code: 'server_error'; readonly message: string };

/** Resolved plan for a renewal cycle — output of `getEffectivePlanForRenewal`. */
export interface EffectivePlanForRenewal {
  readonly planId: string;
  /**
   * `'scheduled'` iff a pending row is driving the resolution; `'current'`
   * when the resolver fell through to the member's current plan.
   */
  readonly source: 'scheduled' | 'current';
}

export type GetEffectivePlanForRenewalError =
  | { readonly code: 'member_not_found'; readonly memberId: string }
  | { readonly code: 'server_error'; readonly message: string };
