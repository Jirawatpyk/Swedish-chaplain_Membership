/**
 * K16-2 (R14-S7) — `isOfflineFetchError` helper unit tests.
 *
 * Pins the 3-browser regex coverage that K14-8 added to the schedule-
 * save catch block. Without these tests:
 *   - A future regex change (e.g. tightening `/load failed/i` to
 *     `/load failed/`) silently fails Safari users back to the
 *     generic "saveFailed" copy.
 *   - A `TypeError` from a non-fetch source (`undefined.foo`) might
 *     accidentally start matching one of the patterns and mis-classify
 *     a code bug as "offline".
 *
 * The helper was extracted from `schedule-editor.tsx` for unit
 * testability — see the JSDoc on `isOfflineFetchError` for the
 * browser→message mapping rationale.
 */
import { describe, expect, it } from 'vitest';
import { isOfflineFetchError } from '@/app/(staff)/admin/renewals/settings/schedules/_components/schedule-editor';

describe('isOfflineFetchError() — schedule-editor offline detection', () => {
  describe('returns true for browser-emitted offline TypeErrors', () => {
    it('Chrome: "TypeError: Failed to fetch"', () => {
      const e = new TypeError('Failed to fetch');
      expect(isOfflineFetchError(e)).toBe(true);
    });

    it('Firefox: "TypeError: NetworkError when attempting to fetch resource"', () => {
      const e = new TypeError(
        'NetworkError when attempting to fetch resource',
      );
      expect(isOfflineFetchError(e)).toBe(true);
    });

    it('Safari: "TypeError: Load failed"', () => {
      // K14-8 (R13-S5) closure: Safari was previously falling through
      // to the generic "saveFailed" copy because neither /fetch/i nor
      // /network/i matched its `Load failed` message.
      const e = new TypeError('Load failed');
      expect(isOfflineFetchError(e)).toBe(true);
    });

    it('matches case-insensitively', () => {
      // Real Safari uses lowercase "Load failed"; pin the regex flag
      // is `i` so a Safari version that emitted "LOAD FAILED" would
      // still match.
      expect(isOfflineFetchError(new TypeError('LOAD FAILED'))).toBe(true);
      expect(isOfflineFetchError(new TypeError('Failed to FETCH'))).toBe(true);
      expect(isOfflineFetchError(new TypeError('NETWORKError'))).toBe(true);
    });
  });

  describe('returns false for non-offline causes', () => {
    it('non-TypeError instance (e.g. plain Error) is NOT offline', () => {
      // K15 / K1-E6: server-thrown errors (500, JSON parse failure on
      // a malformed body) come through as plain Error or SyntaxError.
      // Those must route to "saveFailed" not "offline".
      const e = new Error('Failed to fetch');
      expect(isOfflineFetchError(e)).toBe(false);
    });

    it('SyntaxError with offline-like text is NOT offline', () => {
      const e = new SyntaxError(
        'Unexpected token < in JSON at position 0',
      );
      expect(isOfflineFetchError(e)).toBe(false);
    });

    it('TypeError with non-matching message (real code bug) is NOT offline', () => {
      // `TypeError: Cannot read properties of undefined (reading 'x')`
      // is a code bug — must NOT be classified as offline because that
      // would mask the bug under "check your connection" copy.
      const e = new TypeError(
        "Cannot read properties of undefined (reading 'x')",
      );
      expect(isOfflineFetchError(e)).toBe(false);
    });

    it('non-Error throw (string, object) is NOT offline', () => {
      expect(isOfflineFetchError('Failed to fetch')).toBe(false);
      expect(isOfflineFetchError({ message: 'Failed to fetch' })).toBe(false);
      expect(isOfflineFetchError(null)).toBe(false);
      expect(isOfflineFetchError(undefined)).toBe(false);
    });

    it('TypeError with empty message is NOT offline', () => {
      expect(isOfflineFetchError(new TypeError(''))).toBe(false);
    });
  });
});
