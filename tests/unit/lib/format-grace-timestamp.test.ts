/**
 * Unit tests for formatGraceTimestamp (src/lib/format-grace-timestamp.ts).
 *
 * 061-date-standardization — covers:
 *  1. Valid ISO path: the formatter is called with the correct Date + the
 *     'dateTimeMedium' preset key (not an inline options object). A regression
 *     that silently reverts to inline options would drop the BE calendar on th.
 *  2. Invalid ISO fallback (M-err-1): an invalid/empty input returns the raw
 *     string and emits console.error so the silent-failure is at least visible
 *     in DevTools.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  formatGraceTimestamp,
  type GraceFormatter,
} from '@/lib/format-grace-timestamp';

// Sentinel value returned by the stub formatter so assertions can be exact.
const SENTINEL = 'FORMATTED_SENTINEL';

function makeFormatter(): GraceFormatter & {
  dateTime: ReturnType<typeof vi.fn>;
} {
  const dateTime = vi.fn(() => SENTINEL);
  return { dateTime };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('formatGraceTimestamp', () => {
  describe('valid ISO string', () => {
    it('returns the formatter output', () => {
      const fmt = makeFormatter();
      const result = formatGraceTimestamp(fmt, '2026-05-29T10:30:00.000Z');
      expect(result).toBe(SENTINEL);
    });

    it('calls formatter.dateTime with the parsed Date and the "dateTimeMedium" preset key', () => {
      const fmt = makeFormatter();
      const iso = '2026-05-29T10:30:00.000Z';
      formatGraceTimestamp(fmt, iso);

      expect(fmt.dateTime).toHaveBeenCalledOnce();
      const [firstArg, secondArg] = fmt.dateTime.mock.calls[0] as [
        Date,
        string,
      ];
      // First argument must be the Date parsed from the ISO string
      expect(firstArg).toBeInstanceOf(Date);
      expect(firstArg.toISOString()).toBe(iso);
      // Second argument MUST be the preset name — not an inline-options object.
      // Regressing to inline options would silently drop calendar:'buddhist' for th.
      expect(secondArg).toBe('dateTimeMedium');
    });
  });

  describe('invalid ISO string — M-err-1 fallback', () => {
    it('returns the raw input string for a non-date string', () => {
      const fmt = makeFormatter();
      const spy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const result = formatGraceTimestamp(fmt, 'not-a-date');
      expect(result).toBe('not-a-date');
      spy.mockRestore();
    });

    it('calls console.error when the input is not a valid date', () => {
      const fmt = makeFormatter();
      const spy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      formatGraceTimestamp(fmt, 'not-a-date');
      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });

    it('does NOT call formatter.dateTime when the input is invalid', () => {
      const fmt = makeFormatter();
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      formatGraceTimestamp(fmt, 'not-a-date');
      expect(fmt.dateTime).not.toHaveBeenCalled();
    });

    it('returns the raw input string for an empty string', () => {
      const fmt = makeFormatter();
      const spy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      const result = formatGraceTimestamp(fmt, '');
      expect(result).toBe('');
      spy.mockRestore();
    });

    it('calls console.error when the input is an empty string', () => {
      const fmt = makeFormatter();
      const spy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      formatGraceTimestamp(fmt, '');
      expect(spy).toHaveBeenCalledOnce();
      spy.mockRestore();
    });
  });
});
