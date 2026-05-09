/**
 * T044 (F8 Phase 2 Wave E) — `RenewalEscalationTaskRepo` Application port.
 *
 * Domain-typed repository over `renewal_escalation_tasks` (Wave C
 * migration 0092). Idempotent on `(tenant, member, cycle, task_type)
 * WHERE status='open'`.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
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
  /**
   * Per-user-tray filter. Accepts:
   *   - A specific user UUID — matches `assigned_to_user_id = <uuid>`
   *   - `'__unassigned__'` (Phase 8 T214 sentinel) — matches
   *     `assigned_to_user_id IS NULL` (tasks assigned by role only).
   * Anything else falls through to a literal `eq()` comparison.
   */
  readonly assignedToUserIdFilter?: string;
  readonly overdueOnly?: boolean;
  readonly sort?: 'due_at_asc' | 'due_at_desc' | 'created_at_desc';
}

/** F8 Phase 8 T214 — unassigned-tray sentinel for `assignedToUserIdFilter`. */
export const ESCALATION_UNASSIGNED_FILTER = '__unassigned__' as const;

export interface EscalationTaskPage {
  readonly items: ReadonlyArray<RenewalEscalationTask>;
  readonly nextCursor: string | null;
  readonly totalCount?: number;
}

/**
 * F8 Phase 8 T219 (E1 close) — admin-queue row enriched with the
 * member-side fields the spec AS1 mandates (member name, tier bucket,
 * expiry date) so the queue cell can render without a per-row N+1
 * lookup.
 *
 * Spec line 173: "the task appears in `/admin/renewals/tasks` with the
 * member's name, tier, expiry, suggested action, and links to the
 * member detail page". `task_type` (suggested action) + `cycleId`
 * (link target) come from the base task row; the additional fields
 * here are populated by a LEFT JOIN on `members` + `renewal_cycles`.
 *
 * Modelled as an intersection (NOT `interface … extends …`) because
 * `RenewalEscalationTask` is a discriminated union — TS rejects an
 * interface extending a union.
 *
 * Fields are nullable — defensive against archived members or tasks
 * whose cycle was cancelled (UI falls back to the bare task data).
 */
export type EscalationTaskWithMember = RenewalEscalationTask & {
  readonly memberCompanyName: string | null;
  readonly memberTierBucket: string | null;
  readonly cycleExpiresAt: string | null;
};

export interface EscalationTaskAdminQueuePage {
  readonly items: ReadonlyArray<EscalationTaskWithMember>;
  readonly nextCursor: string | null;
}

export interface RenewalEscalationTaskRepo {
  /**
   * Insert a fresh `open` task. Idempotent against the partial UNIQUE
   * `(tenant, member, cycle, task_type) WHERE status='open'` —
   * returns the existing open row when one already exists for the
   * same combination (created=false).
   */
  insertIfAbsent(
    tx: TenantTx,
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
    tx: TenantTx,
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
    tx: TenantTx,
    tenantId: string,
    taskId: TaskId,
    newAssigneeUserId: string,
  ): Promise<RenewalEscalationTask>;

  /**
   * F8 Phase 8 T214 — count rows matching the same filters as `list`.
   * Drives the queue-top "X overdue tasks" banner (FR-045) so the
   * banner copy isn't capped at the page-size of 1.
   *
   * Implementations MUST honour the same RLS-scoped tenant context as
   * the rest of the repo (no `WHERE tenant_id = ?` in callers — the
   * policy adds it automatically).
   */
  countMatching(
    tenantId: string,
    opts: Pick<
      ListEscalationTasksOpts,
      'statusFilter' | 'assignedToUserIdFilter' | 'overdueOnly'
    >,
  ): Promise<number>;

  /**
   * F8 Phase 8 T219 (E1 close) — admin task queue listing enriched with
   * member name + tier bucket + cycle expiry, so the queue cell can
   * render the spec AS1 fields without an N+1 lookup. Mirrors Phase 7
   * `tierUpgradeRepo.listForAdminQueue`.
   *
   * Cursor pagination uses `(due_at, task_id)` keyset for deterministic
   * ordering — the cursor is an opaque string representation of the
   * last task's `due_at` + `task_id`. `nextCursor: null` when fewer
   * than `pageSize` rows match.
   */
  listForAdminQueue(
    tenantId: string,
    opts: ListEscalationTasksOpts,
  ): Promise<EscalationTaskAdminQueuePage>;
}

export class EscalationTaskNotFoundError extends Error {
  override readonly name = 'EscalationTaskNotFoundError';
  constructor(public readonly taskId: string) {
    super(`renewal_escalation_tasks row ${taskId} not found`);
  }
}
