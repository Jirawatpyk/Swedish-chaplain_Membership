/**
 * T036 (F8 Phase 2 Wave D) — `RenewalEscalationTask` aggregate.
 *
 * Domain shape of `renewal_escalation_tasks` (data-model.md § 2.7;
 * migration 0092). 3-state lifecycle (open → done | skipped).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

declare const TaskIdBrand: unique symbol;
export type TaskId = string & { readonly [TaskIdBrand]: true };

const RE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TaskIdError = {
  readonly kind: 'invalid_task_id';
  readonly raw: string;
};

export function asTaskId(raw: string): TaskId {
  return raw as TaskId;
}

export function parseTaskId(raw: string): Result<TaskId, TaskIdError> {
  if (typeof raw !== 'string' || !RE_UUID.test(raw)) {
    return err({ kind: 'invalid_task_id', raw });
  }
  return ok(raw as TaskId);
}

export const ESCALATION_TASK_STATUSES = ['open', 'done', 'skipped'] as const;
export type EscalationTaskStatus = (typeof ESCALATION_TASK_STATUSES)[number];

export const ESCALATION_ASSIGNEE_ROLES = [
  'admin',
  'manager',
  'executive_director',
] as const;
export type EscalationAssigneeRole =
  (typeof ESCALATION_ASSIGNEE_ROLES)[number];

/** Common fields across every escalation-task lifecycle state. */
interface RenewalEscalationTaskBase {
  readonly tenantId: string;
  readonly taskId: TaskId;
  readonly memberId: string;
  /** NULL for non-cycle tasks (verify_pending_tier_upgrade etc.). */
  readonly cycleId: string | null;
  readonly taskType: string;
  readonly assignedToRole: EscalationAssigneeRole;
  readonly assignedToUserId: string | null;
  readonly dueAt: string;
  readonly relatedSuggestionId: string | null;
  readonly createdAt: string;
}

/** Open: not yet closed. No closedAt / outcome / skipped reason. */
interface OpenEscalationTaskFields {
  readonly status: 'open';
  readonly outcomeNote: null;
  readonly skippedReason: null;
  readonly closedByUserId: null;
  readonly closedAt: null;
}

/** Terminal — admin marked done. closedByUserId + closedAt required. */
interface DoneEscalationTaskFields {
  readonly status: 'done';
  readonly outcomeNote: string | null;
  readonly skippedReason: null;
  readonly closedByUserId: string;
  readonly closedAt: string;
}

/** Terminal — admin skipped with reason. */
interface SkippedEscalationTaskFields {
  readonly status: 'skipped';
  readonly outcomeNote: null;
  readonly skippedReason: string;
  readonly closedByUserId: string;
  readonly closedAt: string;
}

export type RenewalEscalationTask = RenewalEscalationTaskBase &
  (OpenEscalationTaskFields | DoneEscalationTaskFields | SkippedEscalationTaskFields);

export type EscalationTaskInvariantError =
  | { readonly kind: 'outcome_note_too_long'; readonly length: number }
  | { readonly kind: 'skipped_reason_too_long'; readonly length: number };

/**
 * Runtime invariants the type system can't express (string length
 * caps). Status-conditional anchor invariants (open_has_closed_at,
 * done_missing_anchors, skipped_missing_anchors) are enforced at
 * compile time by the `RenewalEscalationTask` discriminated union.
 */
export function assertEscalationTaskInvariants(
  t: RenewalEscalationTask,
): Result<void, EscalationTaskInvariantError> {
  if (t.outcomeNote != null && t.outcomeNote.length > 1000) {
    return err({ kind: 'outcome_note_too_long', length: t.outcomeNote.length });
  }
  if (t.skippedReason != null && t.skippedReason.length > 500) {
    return err({
      kind: 'skipped_reason_too_long',
      length: t.skippedReason.length,
    });
  }
  return ok(undefined);
}

export function isOverdueTask(task: RenewalEscalationTask, now: Date): boolean {
  if (task.status !== 'open') return false;
  return Date.parse(task.dueAt) < now.getTime();
}
