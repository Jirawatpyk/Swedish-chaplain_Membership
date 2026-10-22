/**
 * Unit — `parseIsoCalendarDate`, the one `YYYY-MM-DD` URL-param validator
 * shared by the admin invoice list's `?dueBefore` / `?dueAfter` (server page)
 * and their chips (client), so data and chip can never split-brain.
 */
import { describe, it, expect } from 'vitest';
import { parseIsoCalendarDate } from '@/lib/iso-calendar-date';

describe('parseIsoCalendarDate', () => {
  it('returns a real calendar date unchanged', () => {
    expect(parseIsoCalendarDate('2026-01-01')).toBe('2026-01-01');
    expect(parseIsoCalendarDate('2028-02-29')).toBe('2028-02-29');
  });

  it('rejects a day V8 would roll over (2026-02-30 is not a date)', () => {
    expect(parseIsoCalendarDate('2026-02-30')).toBeUndefined();
    expect(parseIsoCalendarDate('2027-02-29')).toBeUndefined();
  });

  it('rejects any other shape, null and absent', () => {
    for (const raw of ['garbage', '2026-1-01', '2026-01-01T00:00:00Z', ' 2026-01-01', '']) {
      expect(parseIsoCalendarDate(raw)).toBeUndefined();
    }
    expect(parseIsoCalendarDate(null)).toBeUndefined();
    expect(parseIsoCalendarDate(undefined)).toBeUndefined();
  });
});
