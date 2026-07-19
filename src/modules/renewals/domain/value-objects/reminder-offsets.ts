/**
 * Pure, client-bundle-safe reminder-offset grammar for the schedule editor.
 * Mirrors the gateway's `RENEWAL_REMINDER_OFFSETS` (infrastructure) — a parity
 * unit test guards against drift. Kept in domain so `@/modules/renewals/client`
 * can re-export it without dragging infrastructure into the client bundle.
 */
import type { RenewalReminderOffset } from '../../infrastructure/email/templates/copy';
import type { TierBucket } from './tier-bucket';

export type { RenewalReminderOffset };

export const RENEWAL_SCHEDULE_OFFSETS = [
  't-120', 't-90', 't-60', 't-30', 't-14', 't-7', 't-3', 't+0', 't+7', 't+14', 't+30',
] as const satisfies readonly RenewalReminderOffset[];

export const TIER_REMINDER_OFFSETS: Record<TierBucket, readonly RenewalReminderOffset[]> = {
  thai_alumni: ['t-30', 't-14', 't-3', 't+7'],
  start_up: ['t-60', 't-30', 't-14', 't-7', 't+0', 't+7'],
  regular: ['t-60', 't-30', 't-14', 't-7', 't+0', 't+7'],
  premium: ['t-90', 't-60', 't-30', 't-14', 't-7', 't+0', 't+14'],
  partnership: ['t-120', 't-90', 't-30', 't-14', 't+0', 't+30'],
};

export function offsetKeyFromDays(days: number): string {
  return `t${days < 0 ? '-' : '+'}${Math.abs(days)}`;
}

export function daysFromOffsetKey(key: string): number {
  const sign = key.charAt(1) === '-' ? -1 : 1;
  return sign * Number(key.slice(2));
}

export function isScheduleOffset(key: string): key is RenewalReminderOffset {
  return (RENEWAL_SCHEDULE_OFFSETS as readonly string[]).includes(key);
}
