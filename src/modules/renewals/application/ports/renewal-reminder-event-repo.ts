/**
 * T042 (F8 Phase 2 Wave E) — `RenewalReminderEventRepo` Application port.
 *
 * Domain-typed repository over `renewal_reminder_events` (Wave C
 * migration 0088). Idempotency-aware: `insertIfAbsent` matches the
 * UNIQUE INDEX `(tenant, cycle, step_id, year_in_cycle)` so re-running
 * the daily dispatcher cron is a no-op.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { CycleId } from '../../domain/renewal-cycle';

export type ReminderEventChannel = 'email' | 'task';
export type ReminderEventStatus = 'pending' | 'sent' | 'skipped' | 'failed';

export interface ReminderEvent {
  readonly tenantId: string;
  readonly reminderEventId: string;
  readonly cycleId: string;
  readonly stepId: string;
  readonly channel: ReminderEventChannel;
  readonly templateId: string | null;
  readonly taskType: string | null;
  readonly dispatchedAt: string | null;
  readonly deliveryId: string | null;
  readonly status: ReminderEventStatus;
  readonly skipReason: string | null;
  readonly failureReason: string | null;
  readonly actorUserId: string | null;
  readonly yearInCycle: number;
  readonly createdAt: string;
  /**
   * F8 Phase 4 Wave I2e — FR-010a retry budget.
   * Non-null when the row is a transient failure within the 24h retry
   * window. Null for non-failed rows or permanent failures.
   */
  readonly retryUntil: string | null;
  /**
   * Set by the retry use-case when transitioning to permanent failure
   * after the 24h budget exhausts. Idempotency primitive for the
   * "emit permanent audit + create task once" contract.
   */
  readonly retryExhaustedAt: string | null;
}

export interface NewReminderEventInput {
  readonly tenantId: string;
  readonly cycleId: CycleId;
  readonly stepId: string;
  readonly yearInCycle: number;
  readonly channel: ReminderEventChannel;
  readonly templateId?: string;
  readonly taskType?: string;
  readonly actorUserId?: string;
}

export interface ReminderEventTransitionInput {
  readonly tenantId: string;
  readonly reminderEventId: string;
  readonly nextStatus: Exclude<ReminderEventStatus, 'pending'>;
  readonly dispatchedAt?: string;
  readonly deliveryId?: string;
  readonly skipReason?: string;
  readonly failureReason?: string;
  /**
   * Wave I2e — set on transient gateway failures
   * (`dispatched_at + 24h`). NULL on permanent failures so retry pass
   * skips them. Caller computes the value; adapter persists verbatim.
   */
  readonly retryUntil?: string | null;
}

/**
 * Wave I2e — Args for retry-eligible cursor used by `listRetryEligible`.
 */
export interface ListRetryEligibleArgs {
  readonly nowIso: string;
  readonly pageSize: number;
}

/**
 * Wave I2e — Args for exhausted-retry cursor used by `listRetryExhausted`.
 * Returns events whose `retry_until <= now` AND `retry_exhausted_at IS NULL`
 * — needs the permanent-audit emission + manual_outreach_required task.
 */
export interface ListRetryExhaustedArgs {
  readonly nowIso: string;
  readonly pageSize: number;
}

/**
 * Wave I2e — Args for marking a row as exhausted (idempotency primitive
 * for permanent-audit emission).
 */
export interface MarkRetryExhaustedInput {
  readonly tenantId: string;
  readonly reminderEventId: string;
  readonly exhaustedAtIso: string;
}

export interface RenewalReminderEventRepo {
  /**
   * Insert if absent — uses `INSERT … ON CONFLICT DO NOTHING` against
   * the idempotency UNIQUE index. Returns:
   *   - the inserted row when no existing row matched
   *   - the existing row when `(cycle, step, year)` already had a
   *     reminder event (idempotency-replay path)
   * Caller can branch on `created` boolean to distinguish first-fire
   * from replay.
   */
  insertIfAbsent(
    tx: unknown,
    input: NewReminderEventInput,
  ): Promise<{ readonly created: boolean; readonly row: ReminderEvent }>;

  /** Transition pending → sent | skipped | failed. */
  transitionStatus(
    tx: unknown,
    input: ReminderEventTransitionInput,
  ): Promise<ReminderEvent>;

  /**
   * F8 Phase 4 Wave I2e — transition `failed → sent` for the retry
   * success path (FR-010a). Differs from `transitionStatus` in that
   * the source state is `failed`, not `pending`. UPDATE WHERE
   * `status='failed' AND retry_exhausted_at IS NULL` ensures only one
   * caller wins (defends against concurrent retry-pass invocations).
   * Also clears `retry_until` (no longer eligible for retry pickup).
   *
   * Throws `ReminderEventNotFoundError` when zero affected rows
   * (concurrent retry won, or row was permanently exhausted).
   */
  transitionFailedToSent(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly reminderEventId: string;
      readonly dispatchedAt: string;
      readonly deliveryId: string;
    },
  ): Promise<ReminderEvent>;

  /**
   * Per-cycle history for the admin pipeline detail page. Ordered by
   * `dispatched_at DESC` (with NULLs last so still-pending rows
   * surface above sent ones).
   */
  listForCycle(
    tenantId: string,
    cycleId: CycleId,
  ): Promise<ReadonlyArray<ReminderEvent>>;

  /**
   * Failure cursor for retry tooling + ops alerts (failed_idx partial
   * index in migration 0088).
   */
  listFailedSince(
    tenantId: string,
    sinceIso: string,
    limit: number,
  ): Promise<ReadonlyArray<ReminderEvent>>;

  /**
   * F8 Phase 4 Wave I2e — list reminder events eligible for retry
   * (status='failed' AND retry_until > nowIso). Index-served by the
   * partial `renewal_reminder_events_retry_eligible_idx` (migration
   * 0105). Ordered ascending on retry_until so the closest-to-expiry
   * events are processed first.
   */
  listRetryEligible(
    tenantId: string,
    args: ListRetryEligibleArgs,
  ): Promise<ReadonlyArray<ReminderEvent>>;

  /**
   * F8 Phase 4 Wave I2e — list events whose 24h retry window has
   * expired but have not yet been audited as permanent failures
   * (status='failed' AND retry_until <= nowIso AND retry_exhausted_at
   * IS NULL). Caller emits `renewal_reminder_send_failed_permanent` +
   * creates `manual_outreach_required` task + calls `markRetryExhausted`
   * to set the idempotency timestamp.
   */
  listRetryExhausted(
    tenantId: string,
    args: ListRetryExhaustedArgs,
  ): Promise<ReadonlyArray<ReminderEvent>>;

  /**
   * F8 Phase 4 Wave I2e — mark a row as permanently exhausted. Sets
   * `retry_exhausted_at` to defeat duplicate permanent-audit emission
   * on subsequent retry passes. UPDATE WHERE
   * `retry_exhausted_at IS NULL` — concurrent calls deterministically
   * produce one winner (the loser sees zero affected rows + throws
   * `ReminderEventNotFoundError` which the caller treats as
   * idempotent replay).
   */
  markRetryExhausted(
    tx: unknown,
    input: MarkRetryExhaustedInput,
  ): Promise<ReminderEvent>;
}

export class ReminderEventNotFoundError extends Error {
  override readonly name = 'ReminderEventNotFoundError';
  constructor(public readonly reminderEventId: string) {
    super(`renewal_reminder_events row ${reminderEventId} not found`);
  }
}
