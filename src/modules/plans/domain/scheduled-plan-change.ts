/**
 * Scheduled-plan-change Domain types (F2 cross-module table).
 *
 * Pure TypeScript — no framework imports (Constitution Principle III).
 * Domain layer for the `scheduled_plan_changes` table defined at
 * `specs/011-renewal-reminders/data-model.md § 2.9`. Migration 0086
 * created the table; migrations 0124-0126 added hardening (FK to
 * `renewal_cycles`, status↔timestamp CHECK constraint, trigger
 * `search_path` fix). The Drizzle adapter implementing
 * `ScheduledPlanChangeRepo` lives at
 * `src/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo.ts`.
 *
 * Lifecycle (`specs/011-renewal-reminders/data-model.md § 2.9` state machine):
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

/**
 * Error thrown by `assertValidScheduledPlanChange` (R2 Batch 3a / R2-C4)
 * when a row violates the status↔timestamp invariant. Defence-in-depth
 * runtime validator — the DB CHECK already enforces this; the assert
 * catches drift in hand-crafted test fixtures + in-memory contract
 * test repos + future hydration paths that bypass the canonical
 * `rowToDomain`.
 */
export class InvalidScheduledPlanChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScheduledPlanChangeError';
  }
}

/** Aggregate row shape — mirrors `specs/011-renewal-reminders/data-model.md § 2.9` columns 1:1. */
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

/**
 * R2 Batch 3a (R2-C4) — runtime defence-in-depth validator for the
 * status↔timestamp invariant. The interface above encodes the
 * invariant in comments only ("non-null iff status === '…'");
 * nothing prevents constructing `{ status: 'applied', appliedAt: null,
 * supersededAt: '...', cancelledAt: '...' }`. This assert function
 * documents the 4 invariants in CODE, throws
 * `InvalidScheduledPlanChangeError` on violation, and narrows the
 * caller's type via TypeScript assertion-function semantics.
 *
 * Called from the Drizzle adapter's `rowToDomain` to validate every
 * row read; the DB CHECK constraint should already enforce this, but
 * the assert catches (a) drift in test-fixture construction, (b)
 * future hydration paths that bypass `rowToDomain`, and (c) any DB
 * CHECK drift during schema migrations.
 */
export function assertValidScheduledPlanChange(
  row: ScheduledPlanChange,
): asserts row is ScheduledPlanChange {
  const expectedNonNullByStatus = {
    pending: { applied: false, superseded: false, cancelled: false },
    applied: { applied: true, superseded: false, cancelled: false },
    superseded: { applied: false, superseded: true, cancelled: false },
    cancelled: { applied: false, superseded: false, cancelled: true },
  } as const;

  const expected = expectedNonNullByStatus[row.status];
  const actual = {
    applied: row.appliedAt !== null,
    superseded: row.supersededAt !== null,
    cancelled: row.cancelledAt !== null,
  };

  if (
    actual.applied !== expected.applied ||
    actual.superseded !== expected.superseded ||
    actual.cancelled !== expected.cancelled
  ) {
    throw new InvalidScheduledPlanChangeError(
      `ScheduledPlanChange ${row.scheduledChangeId} violates status↔timestamp invariant: ` +
        `status=${row.status} expected (applied=${expected.applied},superseded=${expected.superseded},cancelled=${expected.cancelled}) ` +
        `but got (applied=${actual.applied},superseded=${actual.superseded},cancelled=${actual.cancelled})`,
    );
  }
}

// --- F2 R6 Batch 2c (D7) — `cancelScheduledPlanChange` types -----------------

/**
 * Caller-supplied fields when cancelling a pending scheduled plan change.
 * The use-case looks up the row by `scheduledChangeId`, asserts it is
 * still `pending` (terminal-state immutability is a Domain invariant),
 * transitions it to `cancelled`, and emits the `plan_change_cancelled`
 * audit event.
 *
 * `reason` is optional free-form text (≤500 chars enforced in zod at
 * the future API boundary — none yet today). Mirrors the optional
 * `reason` on `ScheduleNextRenewalPlanChangeInput`.
 */
export interface CancelScheduledPlanChangeInput {
  readonly scheduledChangeId: string;
  /** UUID of the member the scheduled change belongs to — required for the audit payload. */
  readonly memberId: string;
  /** The renewal cycle this change targets — required for the audit payload. */
  readonly effectiveAtCycleId: string;
  readonly cancelledByUserId: string;
  /**
   * R2 Batch 3f (R2-S10) — explicit `string | null` (not `?: string`)
   * to avoid the `exactOptionalPropertyTypes` spread footgun + align
   * with the audit payload shape (`reason: string | null`). Callers
   * pass `null` when no reason; the legacy `undefined` works too via
   * the use-case's `input.reason ?? null` normalisation.
   */
  readonly reason: string | null;
}

export type CancelScheduledPlanChangeError =
  | { readonly code: 'invalid_input'; readonly field: string }
  | { readonly code: 'not_found'; readonly scheduledChangeId: string }
  | {
      readonly code: 'already_terminal';
      readonly scheduledChangeId: string;
      readonly status: Exclude<ScheduledPlanChangeStatus, 'pending'>;
    }
  | {
      // R3 Batch 4b (R3-I5) — preserve audit-error discriminator
      // (`invalid_payload` vs `persist_failed`) so the route can map
      // to distinct `errorId: 'F2.PLAN_CHANGE.CANCEL_AUDIT_INVALID_PAYLOAD'`
      // vs `…_PERSIST_FAILED`. Without this, SRE cannot tell whether
      // the audit row was rejected by zod (deploy-skew) or by the DB
      // (column drift / pgEnum drift / RLS) without raw stdout.
      readonly code: 'audit_failed';
      readonly auditErrorType: 'invalid_payload' | 'persist_failed';
      readonly message: string;
    }
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
