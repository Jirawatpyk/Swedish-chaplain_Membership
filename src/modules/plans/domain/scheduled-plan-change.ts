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
 * Error thrown by `assertValidScheduledPlanChange` when a row
 * violates the status↔timestamp invariant. Defence-in-depth
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

/**
 * Aggregate row shape — mirrors `specs/011-renewal-reminders/data-model.md § 2.9` columns 1:1.
 *
 * Compile-time discriminated union over `status`.
 * The status↔timestamp invariant is encoded in the TYPE (not just
 * in JSDoc comments + the runtime `assertValidScheduledPlanChange`):
 *
 *   - status='pending'    ⇒ appliedAt/supersededAt/cancelledAt all null
 *   - status='applied'    ⇒ appliedAt: string;       supersededAt/cancelledAt: null
 *   - status='superseded' ⇒ supersededAt: string;    appliedAt/cancelledAt: null
 *   - status='cancelled'  ⇒ cancelledAt: string;     appliedAt/supersededAt: null
 *
 * A code site that destructures `row.appliedAt` without narrowing on
 * `row.status === 'applied'` will fail at compile time. The runtime
 * `assertValidScheduledPlanChange` is RETAINED as defence-in-depth
 * for test-fixture drift + future hydration paths that bypass
 * `rowToDomain`.
 */
type ScheduledPlanChangeBase = {
  readonly tenantId: string;
  readonly scheduledChangeId: string;
  readonly memberId: string;
  readonly effectiveAtCycleId: string;
  readonly fromPlanId: string;
  readonly toPlanId: string;
  readonly scheduledByUserId: string;
  readonly reason: string | null;
  /** ISO 8601 UTC. */
  readonly scheduledAt: string;
};

export type PendingScheduledPlanChange = ScheduledPlanChangeBase & {
  readonly status: 'pending';
  readonly appliedAt: null;
  readonly supersededAt: null;
  readonly cancelledAt: null;
};

export type AppliedScheduledPlanChange = ScheduledPlanChangeBase & {
  readonly status: 'applied';
  /** ISO 8601 UTC — required when status==='applied'. */
  readonly appliedAt: string;
  readonly supersededAt: null;
  readonly cancelledAt: null;
};

export type SupersededScheduledPlanChange = ScheduledPlanChangeBase & {
  readonly status: 'superseded';
  readonly appliedAt: null;
  /** ISO 8601 UTC — required when status==='superseded'. */
  readonly supersededAt: string;
  readonly cancelledAt: null;
};

export type CancelledScheduledPlanChange = ScheduledPlanChangeBase & {
  readonly status: 'cancelled';
  readonly appliedAt: null;
  readonly supersededAt: null;
  /** ISO 8601 UTC — required when status==='cancelled'. */
  readonly cancelledAt: string;
};

export type ScheduledPlanChange =
  | PendingScheduledPlanChange
  | AppliedScheduledPlanChange
  | SupersededScheduledPlanChange
  | CancelledScheduledPlanChange;

/**
 * Loose hydration shape — the structural-typed counterpart of
 * `ScheduledPlanChange`. The Drizzle adapter's `rowToDomain` builds
 * this from raw DB columns, then narrows via
 * `assertValidScheduledPlanChange`. Test fixtures that need to
 * deliberately construct invalid status↔timestamp combos (e.g., the
 * `assertValidScheduledPlanChange` defence tests) use this type
 * directly.
 *
 * **Exception note (R4-S6)**: this type is intentionally exported
 * from the barrel because the Drizzle adapter's `rowToDomain` is
 * production infrastructure code (not test-utility) and needs to
 * build the Mutable shape before narrowing. Application-layer code
 * MUST NEVER expose `MutableScheduledPlanChange` as a public
 * function-parameter or return-type — accept/return the discriminated
 * `ScheduledPlanChange` union instead. If a future module needs to
 * pass a non-narrowed shape around, the right answer is to narrow it
 * at the boundary via `assertValidScheduledPlanChange` and propagate
 * the discriminated union. Reviewers: reject PRs that introduce new
 * Application-layer surfaces typed as `MutableScheduledPlanChange`.
 *
 * Code consumers should NEVER accept `MutableScheduledPlanChange` —
 * the discriminated `ScheduledPlanChange` carries the type-level
 * status↔timestamp invariant.
 */
export interface MutableScheduledPlanChange extends ScheduledPlanChangeBase {
  readonly status: ScheduledPlanChangeStatus;
  readonly appliedAt: string | null;
  readonly supersededAt: string | null;
  readonly cancelledAt: string | null;
}

/**
 * Status-aware factory: build a discriminated `ScheduledPlanChange`
 * from a base + status. Test fixtures that previously constructed
 * `ScheduledPlanChange` as a flat shape now call this so the
 * compile-time discriminant is satisfied without per-variant boilerplate.
 *
 * For the `applied`/`superseded`/`cancelled` variants, the matching
 * timestamp MUST be supplied; the other two are always `null`.
 */
export function makeScheduledPlanChange(
  base: ScheduledPlanChangeBase,
  status: 'pending',
): PendingScheduledPlanChange;
export function makeScheduledPlanChange(
  base: ScheduledPlanChangeBase,
  status: 'applied',
  appliedAt: string,
): AppliedScheduledPlanChange;
export function makeScheduledPlanChange(
  base: ScheduledPlanChangeBase,
  status: 'superseded',
  supersededAt: string,
): SupersededScheduledPlanChange;
export function makeScheduledPlanChange(
  base: ScheduledPlanChangeBase,
  status: 'cancelled',
  cancelledAt: string,
): CancelledScheduledPlanChange;
export function makeScheduledPlanChange(
  base: ScheduledPlanChangeBase,
  status: ScheduledPlanChangeStatus,
  timestamp?: string,
): ScheduledPlanChange {
  // R5-S14 — early-return pending separately so TS narrows `status`
  // to the non-pending union AND `timestamp` to `string` in the
  // remaining branches via the runtime guard below. This eliminates
  // the `as string` casts previously used in each terminal-status arm.
  if (status === 'pending') {
    return {
      ...base,
      status: 'pending',
      appliedAt: null,
      supersededAt: null,
      cancelledAt: null,
    };
  }
  // R4-I11 + R5-S14 — TS overloads protect typed callers, but a
  // widened-status call (e.g., `makeScheduledPlanChange(base, status
  // as ScheduledPlanChangeStatus)` via an `any` cast or generic
  // propagation) would bypass the compile-time signature. Catch that
  // path at runtime so a corrupt record with `appliedAt: undefined`
  // cannot escape — the runtime throw is more informative than the
  // downstream `assertValidScheduledPlanChange` failure.
  //
  // The narrowing-via-throw lets TS treat `timestamp` as `string`
  // (not `string | undefined`) in each terminal-status arm below
  // without any `as` casts.
  if (timestamp === undefined) {
    throw new Error(
      `makeScheduledPlanChange: 'timestamp' is required when status='${status}'`,
    );
  }
  switch (status) {
    case 'applied':
      return {
        ...base,
        status: 'applied',
        appliedAt: timestamp,
        supersededAt: null,
        cancelledAt: null,
      };
    case 'superseded':
      return {
        ...base,
        status: 'superseded',
        appliedAt: null,
        supersededAt: timestamp,
        cancelledAt: null,
      };
    case 'cancelled':
      return {
        ...base,
        status: 'cancelled',
        appliedAt: null,
        supersededAt: null,
        cancelledAt: timestamp,
      };
  }
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
 * Runtime defence-in-depth validator for the status↔timestamp
 * invariant. The interface above encodes the
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
  row: MutableScheduledPlanChange,
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

// --- `cancelScheduledPlanChange` types ---------------------------------------

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
  /**
   * Explicit `string | null` (not `?: string`) to avoid the
   * `exactOptionalPropertyTypes` spread footgun + align with the audit
   * payload shape (`reason: string | null`). Callers pass `null` when
   * no reason.
   *
   * `cancelledByUserId` is not on this input: it always equals
   * `deps.actorUserId` (single source of truth via the use-case's
   * `auditCtx.actorUserId`).
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
      // Preserve the audit-error discriminator (`invalid_payload` vs
      // `persist_failed`) so the route can map to distinct
      // `errorId: 'F2.PLAN_CHANGE.CANCEL_AUDIT_INVALID_PAYLOAD'` vs
      // `…_PERSIST_FAILED`. Without this, SRE cannot tell whether the
      // audit row was rejected by zod (deploy-skew) or by the DB
      // (column drift / pgEnum drift / RLS) without raw stdout.
      //
      // Carry the transitioned-row context so the route can return 200
      // with the cancelled-row body + the `X-Audit-Backfill-Required: 1`
      // diagnostic header. The row IS already cancelled at this point;
      // surfacing 500 would mis-lead the UI into retrying a successful
      // mutation.
      readonly code: 'audit_failed';
      readonly auditErrorType: 'invalid_payload' | 'persist_failed';
      readonly message: string;
      readonly transitioned: ScheduledPlanChange;
    }
  | {
      readonly code: 'server_error';
      readonly message: string;
      /**
       * R4-I3 — when the TOCTOU recheck `findById` itself throws
       * (RLS / connection-pool exhaustion / etc.), the inner catch
       * preserves the recheck error message here so the route can
       * emit a distinct `errorId: 'F2.PLAN_CHANGE.CANCEL_RECHECK_FAILED'`
       * log alongside the original transitionStatus error. Without
       * this, the cascading inner failure is invisible.
       */
      readonly recheckErrMessage?: string;
    };

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
