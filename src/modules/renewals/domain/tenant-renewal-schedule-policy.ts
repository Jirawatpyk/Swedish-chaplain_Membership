/**
 * T040 (F8 Phase 2 Wave D) — `TenantRenewalSchedulePolicy` Domain entity.
 *
 * Per-(tenant, tier_bucket) reminder schedule. Domain pairs a parsed
 * list of `ReminderStep` with the tier_bucket that owns it; the
 * dispatcher cron + at-risk widget look up the policy by member's
 * frozen `renewal_tier_bucket` (data-model.md § 2.4 + § 3.2).
 *
 * Steps are kept sorted by `offsetDays` ascending so consumers iterate
 * in chronological order (T-90 before T-30 before T+0 before T+7).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import { type TierBucket } from './value-objects/tier-bucket';
import {
  type ReminderStep,
  parseReminderStep,
  type ReminderStepError,
} from './value-objects/reminder-step';

export interface TenantRenewalSchedulePolicy {
  readonly tenantId: string;
  readonly tierBucket: TierBucket;
  readonly steps: readonly ReminderStep[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type SchedulePolicyError =
  | { readonly kind: 'empty_steps' }
  | { readonly kind: 'duplicate_step_id'; readonly stepId: string }
  | { readonly kind: 'step_parse_failed'; readonly index: number; readonly error: ReminderStepError };

interface RawScheduleStep {
  readonly step_id?: unknown;
  readonly offset_days?: unknown;
  readonly channel?: unknown;
  readonly template_id?: unknown;
  readonly task_type?: unknown;
  readonly assignee_role?: unknown;
}

/**
 * Parse a raw JSONB array (post-DB-fetch or post-JSON.parse) into a
 * typed list of steps. Validates each step structurally + asserts
 * step_id uniqueness across the bucket policy.
 */
export function parseSchedulePolicySteps(
  raw: readonly RawScheduleStep[],
): Result<readonly ReminderStep[], SchedulePolicyError> {
  if (raw.length === 0) {
    return err({ kind: 'empty_steps' });
  }
  const parsed: ReminderStep[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const stepRaw = raw[i] as RawScheduleStep;
    const r = parseReminderStep(stepRaw);
    if (!r.ok) {
      return err({ kind: 'step_parse_failed', index: i, error: r.error });
    }
    if (seenIds.has(r.value.stepId)) {
      return err({ kind: 'duplicate_step_id', stepId: r.value.stepId });
    }
    seenIds.add(r.value.stepId);
    parsed.push(r.value);
  }
  // Sort by offsetDays ascending so consumers see T-N before T+N.
  parsed.sort((a, b) => a.offsetDays - b.offsetDays);
  return ok(parsed);
}

/**
 * Find the step that should fire today given a base anchor (typically
 * cycle.expiresAt) + the current date. Returns the FIRST matching step
 * whose `(anchor + offsetDays)` falls on `nowDateOnly` (UTC date
 * comparison).
 *
 * Returns null when no step matches today's date — the dispatcher
 * passes the cycle through without action.
 */
export function findStepForDate(
  policy: TenantRenewalSchedulePolicy,
  anchor: Date,
  now: Date,
): ReminderStep | null {
  const ms = 24 * 60 * 60 * 1000;
  const todayUtc = Math.floor(now.getTime() / ms);
  for (const step of policy.steps) {
    const target = Math.floor(anchor.getTime() / ms) + step.offsetDays;
    if (target === todayUtc) return step;
  }
  return null;
}
