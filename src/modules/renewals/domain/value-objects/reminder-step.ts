/**
 * T033 (F8 Phase 2 Wave D) — `ReminderStep` Domain value object.
 *
 * One step inside a `tenant_renewal_schedule_policies.steps_jsonb`
 * array. Domain mirrors the JSONB shape declared in the Drizzle schema
 * (`schema-tenant-renewal-config.ts` ScheduleStepJson interface) but
 * adds runtime parsing + invariant assertions that the JSONB type can't
 * express — channel-payload discriminant + offset_days finite range.
 *
 * Channel discriminant (matches data-model.md § 2.4):
 *   - email channel → template_id NOT NULL + task_type NULL +
 *     assignee_role NULL
 *   - task  channel → task_type NOT NULL + assignee_role NOT NULL +
 *     template_id NULL
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

export const REMINDER_CHANNELS = ['email', 'task'] as const;
export type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

export const REMINDER_ASSIGNEE_ROLES = [
  'admin',
  'manager',
  'executive_director',
] as const;
export type ReminderAssigneeRole = (typeof REMINDER_ASSIGNEE_ROLES)[number];

/**
 * Sanity range for offset_days. Schedule policies up to T-120 days
 * (partnership tier quarterly_review_meeting) on the negative side and
 * T+30 days on the positive side. Wider than that is almost certainly
 * a typo or missed unit conversion (e.g. month-vs-day mix-up).
 */
export const REMINDER_OFFSET_DAYS_MIN = -365;
export const REMINDER_OFFSET_DAYS_MAX = 365;

export interface ReminderStepEmail {
  readonly stepId: string;
  /** Negative = before expires_at; positive = after. */
  readonly offsetDays: number;
  readonly channel: 'email';
  readonly templateId: string;
}

export interface ReminderStepTask {
  readonly stepId: string;
  readonly offsetDays: number;
  readonly channel: 'task';
  readonly taskType: string;
  readonly assigneeRole: ReminderAssigneeRole;
}

export type ReminderStep = ReminderStepEmail | ReminderStepTask;

export type ReminderStepError =
  | { readonly kind: 'missing_step_id' }
  | { readonly kind: 'invalid_channel'; readonly raw: string }
  | { readonly kind: 'offset_days_out_of_range'; readonly offsetDays: number }
  | { readonly kind: 'offset_days_not_integer'; readonly offsetDays: number }
  | { readonly kind: 'email_step_missing_template_id' }
  | { readonly kind: 'email_step_has_task_fields' }
  | { readonly kind: 'task_step_missing_task_type' }
  | { readonly kind: 'task_step_missing_assignee_role' }
  | { readonly kind: 'task_step_invalid_assignee_role'; readonly raw: string }
  | { readonly kind: 'task_step_has_template_id' };

interface ReminderStepRawJson {
  readonly step_id?: unknown;
  readonly offset_days?: unknown;
  readonly channel?: unknown;
  readonly template_id?: unknown;
  readonly task_type?: unknown;
  readonly assignee_role?: unknown;
}

/**
 * Parse a raw JSONB-shaped object (after JSON.parse or Drizzle row
 * extraction) into a typed `ReminderStep`. Rejects every shape that
 * the channel-payload discriminant can detect at runtime.
 */
export function parseReminderStep(
  raw: ReminderStepRawJson,
): Result<ReminderStep, ReminderStepError> {
  if (typeof raw.step_id !== 'string' || raw.step_id.length === 0) {
    return err({ kind: 'missing_step_id' });
  }
  if (typeof raw.offset_days !== 'number') {
    return err({ kind: 'offset_days_not_integer', offsetDays: NaN });
  }
  if (!Number.isInteger(raw.offset_days)) {
    return err({
      kind: 'offset_days_not_integer',
      offsetDays: raw.offset_days,
    });
  }
  if (
    raw.offset_days < REMINDER_OFFSET_DAYS_MIN ||
    raw.offset_days > REMINDER_OFFSET_DAYS_MAX
  ) {
    return err({
      kind: 'offset_days_out_of_range',
      offsetDays: raw.offset_days,
    });
  }

  if (typeof raw.channel !== 'string') {
    return err({ kind: 'invalid_channel', raw: String(raw.channel) });
  }
  if (raw.channel === 'email') {
    if (typeof raw.template_id !== 'string' || raw.template_id.length === 0) {
      return err({ kind: 'email_step_missing_template_id' });
    }
    if (raw.task_type != null || raw.assignee_role != null) {
      return err({ kind: 'email_step_has_task_fields' });
    }
    return ok({
      stepId: raw.step_id,
      offsetDays: raw.offset_days,
      channel: 'email',
      templateId: raw.template_id,
    });
  }
  if (raw.channel === 'task') {
    if (typeof raw.task_type !== 'string' || raw.task_type.length === 0) {
      return err({ kind: 'task_step_missing_task_type' });
    }
    if (typeof raw.assignee_role !== 'string') {
      return err({ kind: 'task_step_missing_assignee_role' });
    }
    if (
      !(REMINDER_ASSIGNEE_ROLES as readonly string[]).includes(raw.assignee_role)
    ) {
      return err({
        kind: 'task_step_invalid_assignee_role',
        raw: raw.assignee_role,
      });
    }
    if (raw.template_id != null) {
      return err({ kind: 'task_step_has_template_id' });
    }
    return ok({
      stepId: raw.step_id,
      offsetDays: raw.offset_days,
      channel: 'task',
      taskType: raw.task_type,
      assigneeRole: raw.assignee_role as ReminderAssigneeRole,
    });
  }
  return err({ kind: 'invalid_channel', raw: raw.channel });
}

/** Convert a typed `ReminderStep` back to JSONB shape for persistence. */
export function reminderStepToJson(step: ReminderStep): ReminderStepRawJson {
  if (step.channel === 'email') {
    return {
      step_id: step.stepId,
      offset_days: step.offsetDays,
      channel: 'email',
      template_id: step.templateId,
    };
  }
  return {
    step_id: step.stepId,
    offset_days: step.offsetDays,
    channel: 'task',
    task_type: step.taskType,
    assignee_role: step.assigneeRole,
  };
}
