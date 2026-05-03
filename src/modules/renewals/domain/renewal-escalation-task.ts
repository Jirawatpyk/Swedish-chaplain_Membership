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

export interface RenewalEscalationTask {
  readonly tenantId: string;
  readonly taskId: TaskId;
  readonly memberId: string;
  /** NULL for non-cycle tasks (verify_pending_tier_upgrade etc.). */
  readonly cycleId: string | null;
  readonly taskType: string;
  readonly assignedToRole: EscalationAssigneeRole;
  readonly assignedToUserId: string | null;
  readonly dueAt: string;
  readonly status: EscalationTaskStatus;
  readonly outcomeNote: string | null;
  readonly skippedReason: string | null;
  readonly closedByUserId: string | null;
  readonly relatedSuggestionId: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

export type EscalationTaskInvariantError =
  | { readonly kind: 'open_has_closed_at' }
  | { readonly kind: 'done_missing_anchors' }
  | { readonly kind: 'skipped_missing_anchors' }
  | { readonly kind: 'outcome_note_too_long'; readonly length: number }
  | { readonly kind: 'skipped_reason_too_long'; readonly length: number };

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
  if (t.status === 'open' && t.closedAt != null) {
    return err({ kind: 'open_has_closed_at' });
  }
  if (t.status === 'done') {
    if (t.closedAt == null || t.closedByUserId == null) {
      return err({ kind: 'done_missing_anchors' });
    }
  }
  if (t.status === 'skipped') {
    if (t.closedAt == null || t.skippedReason == null) {
      return err({ kind: 'skipped_missing_anchors' });
    }
  }
  return ok(undefined);
}

export function isOverdueTask(task: RenewalEscalationTask, now: Date): boolean {
  if (task.status !== 'open') return false;
  return Date.parse(task.dueAt) < now.getTime();
}
