/**
 * T028 (US1) — `cycleKeyFor` unit tests.
 *
 * The per-insight suppression-window key (data-model § 2, critique L3):
 *   - membership_year insights → calendar year in the TENANT timezone ("2026")
 *   - iso_week insights        → ISO week-year + week ("2026-W01")
 *
 * Pure — timezone math drives `cycle_key`, so the tenant-TZ year boundary
 * must be exercised (a dismissal at 03:00 Bangkok on Jan 1 belongs to the new
 * year even though it is still Dec 31 in UTC).
 */
import { describe, expect, it } from 'vitest';
import { cycleKeyFor } from '@/modules/insights/domain/insight-cycle-key';

describe('cycleKeyFor', () => {
  describe('membership_year granularity (unused_eblast_quota)', () => {
    it('returns the calendar year in the tenant timezone', () => {
      expect(
        cycleKeyFor('unused_eblast_quota', new Date('2026-06-15T05:00:00Z'), 'Asia/Bangkok'),
      ).toBe('2026');
    });

    it('rolls to the new year at the tenant-TZ boundary (UTC still prior year)', () => {
      // 2025-12-31T20:00Z is 2026-01-01T03:00 in Asia/Bangkok (+7).
      expect(
        cycleKeyFor('unused_eblast_quota', new Date('2025-12-31T20:00:00Z'), 'Asia/Bangkok'),
      ).toBe('2026');
    });

    it('uses UTC year when the tenant timezone is UTC', () => {
      expect(
        cycleKeyFor('underused_event_tickets', new Date('2025-12-31T20:00:00Z'), 'UTC'),
      ).toBe('2025');
    });
  });

  describe('iso_week granularity (at_risk_followup)', () => {
    it('formats ISO week-year + zero-padded week', () => {
      // 2026-01-01 is a Thursday → ISO week 2026-W01.
      expect(
        cycleKeyFor('at_risk_followup', new Date('2026-01-01T06:00:00Z'), 'Asia/Bangkok'),
      ).toBe('2026-W01');
    });

    it('assigns late-December days to the next ISO year when appropriate', () => {
      // 2024-12-30 (Mon) belongs to ISO week 2025-W01.
      expect(
        cycleKeyFor('at_risk_followup', new Date('2024-12-30T06:00:00Z'), 'Asia/Bangkok'),
      ).toBe('2025-W01');
    });
  });
});
