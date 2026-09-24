/**
 * F119 T128 — the reminder / expiry schedule of an E-Blast awaiting the
 * member (FR-022, FR-022a; contracts/dashboard-and-notifications.md § 5,
 * data-model § 3).
 *
 * The clock starts at `stage_entered_at` — the moment the latest version was
 * sent (every entry into `awaiting_member_approval` stamps it and resets
 * `member_reminder_stage` to 0). Day 3 and day 7: reminders to the member.
 * Day 23: a warning to BOTH sides. Day 30: the automatic closure
 * `expired_no_member_response` (`MEMBER_APPROVAL_EXPIRY_DAYS`).
 *
 * **Driven by the counter.** `member_reminder_stage` records the highest
 * threshold already served (1 day-3 · 2 day-7 · 3 day-23), so "exactly one per
 * threshold" holds however many ticks run on the same day and across rounds.
 * A tick that finds several thresholds due (the cron missed days) serves only
 * the LATEST one — a member is never sent two reminders on one day, and the
 * counter jumps to that threshold's stage.
 *
 * **Expiry is date-only.** At day 30 the row closes whatever the counter says:
 * a cron outage between day 23 and day 30 must not keep an E-Blast open past
 * the clock the member was told about. Nothing here ever approves (FR-014).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { MEMBER_APPROVAL_EXPIRY_DAYS } from './member-approval-expiry';

/** The three reminder thresholds, in days after the version was sent. */
export const MEMBER_APPROVAL_REMINDER_DAYS = { day3: 3, day7: 7, day23: 23 } as const;

export type ApprovalReminder = keyof typeof MEMBER_APPROVAL_REMINDER_DAYS;

/** What one tick does to one row. */
export type ApprovalScheduleStep = ApprovalReminder | 'expire';

/**
 * `broadcasts.member_reminder_stage` — how many reminder thresholds were
 * served: 0 none · 1 day-3 · 2 day-7 · 3 day-23 warning. The 0308 CHECK holds
 * the column to exactly these values (PR #392 review C6).
 */
export type MemberReminderStage = 0 | 1 | 2 | 3;

/** The `member_reminder_stage` each reminder advances the counter TO. */
export const REMINDER_STAGE: Readonly<Record<ApprovalReminder, Exclude<MemberReminderStage, 0>>> = {
  day3: 1,
  day7: 2,
  day23: 3,
};

/** The whole timeline the member is told when the clock starts — day 3, 7, 23, 30. */
export const MEMBER_APPROVAL_TIMELINE_DAYS = [
  MEMBER_APPROVAL_REMINDER_DAYS.day3,
  MEMBER_APPROVAL_REMINDER_DAYS.day7,
  MEMBER_APPROVAL_REMINDER_DAYS.day23,
  MEMBER_APPROVAL_EXPIRY_DAYS,
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Latest threshold first — a tick serves the latest one due. */
const LATEST_FIRST: readonly ApprovalReminder[] = ['day23', 'day7', 'day3'];

/**
 * The step due for a row that entered `awaiting_member_approval` at
 * `stageEnteredAt`, at `now`, with `reminderStage` thresholds already served;
 * `null` when nothing is due.
 */
export function nextReminder(
  stageEnteredAt: Date,
  now: Date,
  reminderStage: MemberReminderStage,
): ApprovalScheduleStep | null {
  const elapsed = now.getTime() - stageEnteredAt.getTime();
  if (elapsed >= MEMBER_APPROVAL_EXPIRY_DAYS * DAY_MS) return 'expire';
  for (const reminder of LATEST_FIRST) {
    if (elapsed >= MEMBER_APPROVAL_REMINDER_DAYS[reminder] * DAY_MS) {
      return reminderStage < REMINDER_STAGE[reminder] ? reminder : null;
    }
  }
  return null;
}

/** Whole days the row has waited (the audit's `days_waiting`); never negative. */
export function daysWaiting(stageEnteredAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - stageEnteredAt.getTime()) / DAY_MS));
}
