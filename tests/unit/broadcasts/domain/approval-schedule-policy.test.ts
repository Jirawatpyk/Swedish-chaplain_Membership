/**
 * F119 T128 (FR-022, FR-022a; contracts/dashboard-and-notifications.md § 5) —
 * the member's approval clock: `nextReminder(stageEnteredAt, now,
 * reminderStage)`.
 *
 * The reminders are driven by the COUNTER (`member_reminder_stage`, 0 none ·
 * 1 day-3 · 2 day-7 · 3 day-23 warning), not by date arithmetic alone: a
 * threshold already served is never served again however many ticks run, and
 * the counter's reset to 0 on every entry into `awaiting_member_approval` is
 * what restarts the clock for the next round. Expiry is the one date-only
 * step: at day 30 the row closes whatever the counter says (a tick missed
 * between day 23 and day 30 must not keep the row open).
 */
import { describe, expect, it } from 'vitest';
import {
  MEMBER_APPROVAL_REMINDER_DAYS,
  MEMBER_APPROVAL_TIMELINE_DAYS,
  REMINDER_STAGE,
  daysWaiting,
  nextReminder,
  type ApprovalScheduleStep,
  type MemberReminderStage,
} from '@/modules/broadcasts/domain/approval/approval-schedule-policy';
import { MEMBER_APPROVAL_EXPIRY_DAYS } from '@/modules/broadcasts/domain/approval/member-approval-expiry';

const DAY = 86_400_000;
const T0 = new Date('2026-09-01T04:30:00.000Z');
const at = (days: number, ms = 0) => new Date(T0.getTime() + days * DAY + ms);

/** Run one tick a day for `days` days, advancing the counter the way the cron does. */
function simulate(days: number, startStage: MemberReminderStage = 0): Array<{ day: number; step: ApprovalScheduleStep }> {
  let stage: MemberReminderStage = startStage;
  const fired: Array<{ day: number; step: ApprovalScheduleStep }> = [];
  for (let day = 0; day <= days; day += 1) {
    // Two ticks the same day — the second must be a no-op.
    for (let tick = 0; tick < 2; tick += 1) {
      const step = nextReminder(T0, at(day, tick * 60_000), stage);
      if (step === null) continue;
      fired.push({ day, step });
      if (step === 'expire') return fired;
      stage = REMINDER_STAGE[step];
    }
  }
  return fired;
}

describe('nextReminder — each stage advances at most once per threshold', () => {
  it('across a 40-day clock ticked twice a day: day 3, day 7, day 23, then expiry on day 30 — once each, nothing else', () => {
    expect(simulate(40)).toEqual([
      { day: 3, step: 'day3' },
      { day: 7, step: 'day7' },
      { day: 23, step: 'day23' },
      { day: 30, step: 'expire' },
    ]);
  });

  it('a threshold already served is not served again (the counter, not the date, decides)', () => {
    expect(nextReminder(T0, at(3), 1)).toBeNull();
    expect(nextReminder(T0, at(8), 2)).toBeNull();
    expect(nextReminder(T0, at(29), 3)).toBeNull();
  });

  it('the boundaries are inclusive: one millisecond short of a threshold is nothing', () => {
    expect(nextReminder(T0, at(3, -1), 0)).toBeNull();
    expect(nextReminder(T0, at(3), 0)).toBe('day3');
    expect(nextReminder(T0, at(7, -1), 1)).toBeNull();
    expect(nextReminder(T0, at(7), 1)).toBe('day7');
    expect(nextReminder(T0, at(23, -1), 2)).toBeNull();
    expect(nextReminder(T0, at(23), 2)).toBe('day23');
    expect(nextReminder(T0, at(30, -1), 3)).toBeNull();
    expect(nextReminder(T0, at(30), 3)).toBe('expire');
  });

  it('a missed tick serves the LATEST due threshold only — never two reminders on one day', () => {
    expect(nextReminder(T0, at(10), 0)).toBe('day7');
    expect(nextReminder(T0, at(25), 0)).toBe('day23');
    expect(nextReminder(T0, at(25), 1)).toBe('day23');
    // Catching up from stage 0 at day 10 then ticking on: no day-3 reminder is ever sent late.
    let stage = REMINDER_STAGE.day7;
    const later: ApprovalScheduleStep[] = [];
    for (let day = 11; day <= 30; day += 1) {
      const step = nextReminder(T0, at(day), stage);
      if (step === null) continue;
      later.push(step);
      if (step !== 'expire') stage = REMINDER_STAGE[step];
    }
    expect(later).toEqual(['day23', 'expire']);
  });

  it('expiry is date-only: a row waiting 400 days closes on the first tick whatever its counter says', () => {
    for (const stage of [0, 1, 2, 3] as const) expect(nextReminder(T0, at(400), stage)).toBe('expire');
    expect(simulate(400).filter((f) => f.step === 'expire')).toEqual([{ day: 30, step: 'expire' }]);
  });

  it('a clock that restarts (a new version sent → stage 0, a new stageEnteredAt) serves the thresholds again from the new start', () => {
    const resent = at(5);
    expect(nextReminder(resent, at(7), 0)).toBeNull(); // day 2 of the new round, not day 7 of the old one
    expect(nextReminder(resent, at(8), 0)).toBe('day3');
    expect(nextReminder(resent, at(12), 1)).toBe('day7');
  });

  it('nothing before the first threshold, and nothing for a clock in the future', () => {
    expect(nextReminder(T0, T0, 0)).toBeNull();
    expect(nextReminder(T0, at(-2), 0)).toBeNull();
  });
});

describe('the thresholds are the one timeline the emails state', () => {
  it('3 / 7 / 23 reminders, 30 expiry, in order, and each reminder advances the counter to its own stage', () => {
    expect(MEMBER_APPROVAL_REMINDER_DAYS).toEqual({ day3: 3, day7: 7, day23: 23 });
    expect(MEMBER_APPROVAL_TIMELINE_DAYS).toEqual([3, 7, 23, MEMBER_APPROVAL_EXPIRY_DAYS]);
    expect(REMINDER_STAGE).toEqual({ day3: 1, day7: 2, day23: 3 });
  });

  it('daysWaiting counts whole days since the stage was entered (the audit payload)', () => {
    expect(daysWaiting(T0, at(23))).toBe(23);
    expect(daysWaiting(T0, at(30, -1))).toBe(29);
    expect(daysWaiting(T0, at(400))).toBe(400);
    expect(daysWaiting(T0, at(-1))).toBe(0);
  });
});
