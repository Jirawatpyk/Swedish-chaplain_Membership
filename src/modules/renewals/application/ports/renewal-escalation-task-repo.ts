/**
 * T044 (F8 Phase 2 Wave E) — `RenewalEscalationTaskRepo` Application port.
 *
 * Domain-typed repository over `renewal_escalation_tasks` (Wave C
 * migration 0092). Idempotent on `(tenant, member, cycle, task_type)
 * WHERE status='open'`.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type {
  EscalationAssigneeRole,
  EscalationTaskStatus,
  RenewalEscalationTask,
  TaskId,
} from '../../domain/renewal-escalation-task';

export interface NewEscalationTaskInput {
  readonly tenantId: string;
  readonly taskId: TaskId;
  readonly memberId: string;
  readonly cycleId: string | null;
  readonly taskType: string;
  readonly assignedToRole: EscalationAssigneeRole;
  readonly assignedToUserId?: string;
  readonly dueAt: string;
  readonly relatedSuggestionId?: string;
}

export interface ListEscalationTasksOpts {
  readonly cursor?: string;
  readonly pageSize: number;
  readonly statusFilter?: ReadonlyArray<EscalationTaskStatus>;
  readonly assignedToUserIdFilter?: string;
  readonly overdueOnly?: boolean;
  readonly sort?: 'due_at_asc' | 'due_at_desc' | 'created_at_desc';
}

export interface EscalationTaskPage {
  readonly items: ReadonlyArray<RenewalEscalationTask>;
  readonly nextCursor: string | null;
  readonly totalCount?: number;
}

export interface RenewalEscalationTaskRepo {
  /**
   * Insert a fresh `open` task. Idempotent against the partial UNIQUE
   * `(tenant, member, cycle, task_type) WHERE status='open'` —
   * returns the existing open row when one already exists for the
   * same combination (created=false).
   */
  insertIfAbsent(
    tx: unknown,
    input: NewEscalationTaskInput,
  ): Promise<{
    readonly created: boolean;
    readonly row: RenewalEscalationTask;
  }>;

  findById(
    tenantId: string,
    taskId: TaskId,
  ): Promise<RenewalEscalationTask | null>;

  /** Per-tenant queue cursor (admin task list — queue_idx). */
  list(
    tenantId: string,
    opts: ListEscalationTasksOpts,
  ): Promise<EscalationTaskPage>;

  /** Per-user "my open tasks" view (per_user_idx partial). */
  listOpenForUser(
    tenantId: string,
    userId: string,
  ): Promise<ReadonlyArray<RenewalEscalationTask>>;

  /**
   * F8 Phase 4 Wave I2b — Returns the open tasks for a member of the
   * given type. Index-served by `renewal_escalation_tasks_open_idem_idx`
   * (tenant, member, cycle, task_type) WHERE status='open' — typically
   * returns 0 or 1 row.
   *
   * `cycleId` is intentionally OMITTED from the lookup signature so
   * T091 reset-email-unverified closes ALL `manual_outreach_required`
   * tasks across ALL of the member's cycles (defensive — eliminates
   * the rare "cycle X bounced, then cycle Y bounced before X resolved"
   * double-task case).
   */
  listOpenForMemberByType(
    tenantId: string,
    memberId: string,
    taskType: string,
  ): Promise<ReadonlyArray<RenewalEscalationTask>>;

  /** Transition open → done | skipped. */
  transitionStatus(
    tx: unknown,
    tenantId: string,
    taskId: TaskId,
    args: {
      readonly to: Exclude<EscalationTaskStatus, 'open'>;
      readonly closedAt: string;
      readonly closedByUserId?: string;
      readonly outcomeNote?: string;
      readonly skippedReason?: string;
    },
  ): Promise<RenewalEscalationTask>;

  /** Reassign an open task to a different user. */
  reassign(
    tx: unknown,
    tenantId: string,
    taskId: TaskId,
    newAssigneeUserId: string,
  ): Promise<RenewalEscalationTask>;
}

export class EscalationTaskNotFoundError extends Error {
  override readonly name = 'EscalationTaskNotFoundError';
  constructor(public readonly taskId: string) {
    super(`renewal_escalation_tasks row ${taskId} not found`);
  }
}
