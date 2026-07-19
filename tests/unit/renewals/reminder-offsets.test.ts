import { describe, it, expect } from 'vitest';
import {
  RENEWAL_SCHEDULE_OFFSETS,
  TIER_REMINDER_OFFSETS,
  offsetKeyFromDays,
  daysFromOffsetKey,
  isScheduleOffset,
} from '@/modules/renewals/domain/value-objects/reminder-offsets';
// Parity source of truth lives in infrastructure copy matrix (server-side import OK in a test).
import { RENEWAL_REMINDER_OFFSETS } from '@/modules/renewals/infrastructure/email/templates/copy';

describe('reminder-offsets', () => {
  it('offsetKeyFromDays matches the gateway grammar', () => {
    expect(offsetKeyFromDays(-30)).toBe('t-30');
    expect(offsetKeyFromDays(7)).toBe('t+7');
    expect(offsetKeyFromDays(0)).toBe('t+0');
  });

  it('daysFromOffsetKey is the inverse', () => {
    for (const k of RENEWAL_SCHEDULE_OFFSETS) {
      expect(offsetKeyFromDays(daysFromOffsetKey(k))).toBe(k);
    }
  });

  it('isScheduleOffset gates membership', () => {
    expect(isScheduleOffset('t-30')).toBe(true);
    expect(isScheduleOffset('t-45')).toBe(false);
  });

  it('RENEWAL_SCHEDULE_OFFSETS is exactly the gateway offset set (parity)', () => {
    expect([...RENEWAL_SCHEDULE_OFFSETS].sort()).toEqual(
      [...RENEWAL_REMINDER_OFFSETS].sort(),
    );
  });

  it('every per-tier offset is a valid schedule offset', () => {
    for (const offsets of Object.values(TIER_REMINDER_OFFSETS)) {
      for (const o of offsets) expect(isScheduleOffset(o)).toBe(true);
    }
  });
});
