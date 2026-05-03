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
}

export class ReminderEventNotFoundError extends Error {
  override readonly name = 'ReminderEventNotFoundError';
  constructor(public readonly reminderEventId: string) {
    super(`renewal_reminder_events row ${reminderEventId} not found`);
  }
}
