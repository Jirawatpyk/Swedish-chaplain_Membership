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
    const stepRaw = raw[i]!;
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
 * 063 — Bounded catch-up window (in days) for missed-cron recovery.
 *
 * **Why this exists**: the daily reminder dispatcher previously resolved
 * the due step by STRICT day-equality (`target === todayUtc`). If the
 * cron did NOT run on the exact UTC day a step was due (Vercel reboot,
 * READ_ONLY_MODE window, infra outage), the step's due-day passed and
 * `target < todayUtc` forever → the reminder was NEVER sent (silent
 * drop). The idempotency index prevents double-send but gave NO
 * catch-up. spec.md:194 promises catch-up ("no missed reminders are
 * silently lost — they shift one day later") and FR-010 says dispatch
 * "any reminder step whose offset_day **is due**" (not "is due exactly
 * today"). The admin reactivation ladder already implements the same
 * "threshold-crossed + not-yet-fired" catch-up
 * (`reconcile-pending-reactivations.ts` `decideRemindersToFire`); this
 * brings the member dispatcher in line.
 *
 * **Why 7 (not larger)**: the catch-up must be BOUNDED so a SHORT cron
 * miss recovers but a LONG outage does NOT blast stale reminders (firing
 * a T-90 reminder when it is now T-30 is worse than skipping it). The
 * tightest gap between adjacent seed steps is **7 days** (T-14 → T-7 →
 * T+0 in the start_up/regular policies — see migration
 * `0089_f8_create_tenant_renewal_config_tables.sql`). A 7-day lookback
 * recovers a multi-day outage's MOST-RECENT step without reaching back
 * to a step the next step has already superseded. A step older than 7
 * days is intentionally skipped as stale.
 */
export const REMINDER_CATCH_UP_LOOKBACK_DAYS = 7 as const;

/**
 * Return every step that is due-or-overdue within the bounded catch-up
 * window `[todayUtc - REMINDER_CATCH_UP_LOOKBACK_DAYS, todayUtc]`, where
 * a step's due-day is `floor(anchor/day) + offsetDays` (UTC date
 * comparison). The returned list is sorted MOST-RECENT first (latest
 * due-date first) so the caller fires the most relevant step.
 *
 * Steps strictly in the future (`target > todayUtc`) and steps strictly
 * before the window (`target < todayUtc - lookback`) are excluded.
 *
 * The dispatcher pairs this with its existing idempotency primitive
 * (the `renewal_reminder_events` unique index on
 * `(tenant, cycle, step, year)`): it walks the returned candidates
 * most-recent first and fires the first one NOT yet sent for this
 * (cycle, step, year). Firing only the most-recent unfired step (not
 * all overdue steps) avoids multi-reminder spam in a single catch-up
 * run — matching the reactivation ladder's "fire what's relevant now".
 */
export function findDueStepsForDate(
  policy: TenantRenewalSchedulePolicy,
  anchor: Date,
  now: Date,
): readonly ReminderStep[] {
  const ms = 24 * 60 * 60 * 1000;
  const todayUtc = Math.floor(now.getTime() / ms);
  const anchorDay = Math.floor(anchor.getTime() / ms);
  const lowerBound = todayUtc - REMINDER_CATCH_UP_LOOKBACK_DAYS;
  const due: { step: ReminderStep; target: number }[] = [];
  for (const step of policy.steps) {
    const target = anchorDay + step.offsetDays;
    if (target <= todayUtc && target >= lowerBound) {
      due.push({ step, target });
    }
  }
  // Most-recent (largest target) first. Stable tiebreak on the original
  // ascending-offset order for steps that share a due-day (e.g. a
  // same-offset email + task pair).
  due.sort((a, b) => b.target - a.target);
  return due.map((d) => d.step);
}

/**
 * Find the single step that should fire for `now` given a base anchor
 * (typically `cycle.expiresAt`). Returns the MOST-RECENT step whose
 * due-day falls within the bounded catch-up window
 * `[todayUtc - REMINDER_CATCH_UP_LOOKBACK_DAYS, todayUtc]` — so a step
 * due today OR overdue by up to the lookback resolves (missed-cron
 * recovery), while a future step or a stale step beyond the lookback
 * resolves to null.
 *
 * Returns null when no step is due-or-overdue within the window — the
 * dispatcher passes the cycle through without action (`not_due_today`).
 *
 * Note: prior to 063 this matched by STRICT day-equality
 * (`target === todayUtc`), which silently dropped a reminder whenever
 * the cron missed the exact due-day. Callers that need ALL window
 * candidates (to skip an already-fired most-recent step and fall back
 * to the next-older unfired one) use `findDueStepsForDate`.
 */
export function findStepForDate(
  policy: TenantRenewalSchedulePolicy,
  anchor: Date,
  now: Date,
): ReminderStep | null {
  return findDueStepsForDate(policy, anchor, now)[0] ?? null;
}
