/**
 * F119 T117 / T118 — how long an E-Blast has waited in its current stage,
 * and whether that wait is a pre-warning or a stall (FR-026, FR-027;
 * contracts/dashboard-and-notifications.md § 1.2).
 *
 * ONE comparison against `stage_entered_at`, for every stage somebody is
 * waiting on (`turnOf(status) !== null`):
 *
 *   - marketing-held stages are STALLED at the 48 h review target
 *     (`SLA_RED_HOURS`), and AGING — the pre-warning the queue has always
 *     shown — from `SLA_AMBER_HOURS` (24 h);
 *   - the member-held stage is STALLED at the 3-day first-reminder threshold
 *     (`MEMBER_APPROVAL_REMINDER_DAYS.day3`), with no pre-warning: the member
 *     has 30 days, and a 24 h amber on their clock would flag nearly every
 *     row sent yesterday.
 *
 * Those two numbers are the WHOLE of "stalled" (FR-027). `aging` is never
 * stalled: it is not counted as stalled, not labelled "Stalled" and not
 * announced as one.
 *
 * A stage nobody is waiting on (Draft, Scheduled, Sending, every closed or
 * historical stage) has no age here: `null`.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { BroadcastStatus } from '../value-objects/broadcast-status';
import { MEMBER_APPROVAL_REMINDER_DAYS } from '../approval/approval-schedule-policy';
import { turnOf } from './whose-turn';

/** The queue's pre-warning on a marketing-held stage (Smart-3 / FR-013). */
export const SLA_AMBER_HOURS = 24;
/** The 48 h review target (FR-013) — a marketing-held stage past it is stalled. */
export const SLA_RED_HOURS = 48;
/** The member's first reminder (day 3) — the member-held stage past it is stalled. */
export const MEMBER_STALLED_HOURS = MEMBER_APPROVAL_REMINDER_DAYS.day3 * 24;

export type StageAgeLevel = 'fresh' | 'aging' | 'stalled';

export interface StageAge {
  readonly level: StageAgeLevel;
  /** Whole hours in the stage, never negative (a clock skew reads 0). */
  readonly hours: number;
}

const HOUR_MS = 60 * 60 * 1000;

export function stageAgeOf(status: BroadcastStatus, stageEnteredAt: Date, now: Date): StageAge | null {
  const turn = turnOf(status);
  if (turn === null) return null;
  const hours = Math.max(0, Math.floor((now.getTime() - stageEnteredAt.getTime()) / HOUR_MS));
  const stalledAt = turn === 'member' ? MEMBER_STALLED_HOURS : SLA_RED_HOURS;
  if (hours >= stalledAt) return { level: 'stalled', hours };
  if (turn === 'marketing' && hours >= SLA_AMBER_HOURS) return { level: 'aging', hours };
  return { level: 'fresh', hours };
}
