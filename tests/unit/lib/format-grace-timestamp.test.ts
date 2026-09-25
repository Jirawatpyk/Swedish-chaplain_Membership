/**
 * Unit tests for formatGraceTimestamp (src/lib/format-grace-timestamp.ts).
 *
 * Covers:
 *  1. Valid ISO path: renders the `dateTimeMedium` preset through the central
 *     helper — en-GB day-first with a 24-hour Bangkok time for English (ux-
 *     standards § 12.3), the Buddhist-Era year for th.
 *  2. Invalid ISO fallback (M-err-1): an invalid/empty input returns the raw
 *     string and emits console.error so the silent-failure is at least visible
 *     in DevTools.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatGraceTimestamp } from '@/lib/format-grace-timestamp';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatGraceTimestamp', () => {
  describe('valid ISO string', () => {
    it('en: day-first with a 24-hour Bangkok time', () => {
      // 10:30 UTC = 17:30 Bangkok.
      const result = formatGraceTimestamp('en', '2026-05-29T10:30:00.000Z');
      expect(result).toMatch(/^29 May 2026,? 17:30$/);
    });

    it('th: Buddhist-Era year', () => {
      expect(formatGraceTimestamp('th', '2026-05-29T10:30:00.000Z')).toContain('2569');
    });
  });

  describe('invalid ISO string — M-err-1 fallback', () => {
    it('returns the raw input string for a non-date string', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(formatGraceTimestamp('en', 'not-a-date')).toBe('not-a-date');
    });

    it('calls console.error when the input is not a valid date', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      formatGraceTimestamp('en', 'not-a-date');
      expect(spy).toHaveBeenCalledOnce();
    });

    it('returns an empty input unchanged', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(formatGraceTimestamp('en', '')).toBe('');
    });
  });
});
