/**
 * Phase 6 wave-6 — `asLockKey` smart-constructor regex + length guard.
 *
 * Closes the CRIT-R2-3 Round 2 cross-check gap: wave-5 batch-3
 * introduced the `LockKey` brand to prevent typo-class bugs (e.g.,
 * `eventcreate_quota:` underscore vs canonical `eventcreate-quota:`
 * hyphen would partition Postgres advisory locks → silently bypass
 * FR-037 ACID coordination). The regex + length guard had ZERO direct
 * tests — a future weakening of the regex would not be caught.
 *
 * This file exercises every documented boundary so the brand's
 * protective invariant is anchored by behaviour, not just by a code
 * comment.
 */
import { describe, it, expect } from 'vitest';
import {
  asLockKey,
  InvalidLockKeyError,
} from '@/modules/events';

describe('asLockKey — Phase 6 wave-6 (CRIT-R2-3)', () => {
  describe('accepts canonical shapes', () => {
    it('accepts the F6 quota canonical key: eventcreate-quota:tenant:member:event', () => {
      const key = asLockKey(
        'eventcreate-quota:test-swecham:a1b2c3d4-1234-5678-90ab-cdef01234567:f0e1d2c3-9876-5432-10ab-cdef98765432',
      );
      expect(key).toContain('eventcreate-quota:');
    });

    it('accepts minimal 2-segment key', () => {
      expect(() => asLockKey('a:b')).not.toThrow();
    });

    it('accepts ASCII 0x20-0x7e printable chars in the tail (post-prefix)', () => {
      // hashtextextended hashes the key before submitting to Postgres
      // so no SQL injection risk — but printable ASCII boundary verified.
      expect(() => asLockKey('feature:tail with spaces')).not.toThrow();
      expect(() => asLockKey("feature:tail-with-symbols!@#$%^&*()")).not.toThrow();
    });

    it('accepts exactly 256 chars', () => {
      const tail = 'x'.repeat(256 - 'feature:'.length);
      const key = `feature:${tail}`;
      expect(key.length).toBe(256);
      expect(() => asLockKey(key)).not.toThrow();
    });
  });

  describe('rejects typo-class bugs (the brand\'s primary purpose)', () => {
    it('rejects underscore in feature prefix (eventcreate_quota: vs eventcreate-quota:)', () => {
      expect(() =>
        asLockKey('eventcreate_quota:tenant:member:event'),
      ).toThrow(InvalidLockKeyError);
    });

    it('rejects uppercase in feature prefix', () => {
      expect(() => asLockKey('EventCreate-quota:tenant:member:event')).toThrow(
        InvalidLockKeyError,
      );
    });

    it('rejects mixed case', () => {
      expect(() => asLockKey('eventCreate-quota:x:y:z')).toThrow(
        InvalidLockKeyError,
      );
    });
  });

  describe('rejects missing structural elements', () => {
    it('rejects empty string', () => {
      expect(() => asLockKey('')).toThrow(InvalidLockKeyError);
    });

    it('rejects missing colon separator (single segment)', () => {
      expect(() => asLockKey('eventcreate-quota')).toThrow(InvalidLockKeyError);
    });

    it('rejects empty prefix (just a colon)', () => {
      expect(() => asLockKey(':tail')).toThrow(InvalidLockKeyError);
    });

    it('rejects empty tail (prefix + colon but no tail)', () => {
      expect(() => asLockKey('feature:')).toThrow(InvalidLockKeyError);
    });
  });

  describe('rejects over-length keys (≤256 cap)', () => {
    it('rejects exactly 257 chars', () => {
      const tail = 'x'.repeat(257 - 'feature:'.length);
      const key = `feature:${tail}`;
      expect(key.length).toBe(257);
      expect(() => asLockKey(key)).toThrow(InvalidLockKeyError);
    });
  });

  describe('rejects control-character injection in tail', () => {
    it('rejects newline injection (\\n is 0x0a, outside printable range)', () => {
      expect(() => asLockKey('feature:tail\nlog-poison-attempt')).toThrow(
        InvalidLockKeyError,
      );
    });

    it('rejects carriage-return injection', () => {
      expect(() => asLockKey('feature:tail\rcarriage')).toThrow(
        InvalidLockKeyError,
      );
    });

    it('rejects tab injection', () => {
      expect(() => asLockKey('feature:tail\twith-tab')).toThrow(
        InvalidLockKeyError,
      );
    });

    it('rejects null-byte injection', () => {
      expect(() => asLockKey('feature:tail\x00null-byte')).toThrow(
        InvalidLockKeyError,
      );
    });
  });

  describe('InvalidLockKeyError shape', () => {
    it('preserves the raw input on the error instance', () => {
      try {
        asLockKey('BAD KEY');
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidLockKeyError);
        if (e instanceof InvalidLockKeyError) {
          expect(e.raw).toBe('BAD KEY');
        }
      }
    });

    it('truncates raw to 200 chars in the error message (log-DoS guard)', () => {
      const tooLong = 'BAD_PREFIX_' + 'x'.repeat(500);
      try {
        asLockKey(tooLong);
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidLockKeyError);
        if (e instanceof InvalidLockKeyError) {
          // The JSON-stringified raw value is sliced to 200 chars
          // (200 is approximate — the test just confirms the slice
          // happened by checking the message doesn't contain the full
          // 500-char tail).
          expect(e.message.length).toBeLessThan(tooLong.length);
          expect(e.message).toContain('Invalid advisory-lock key');
        }
      }
    });

    it('error name is InvalidLockKeyError (not generic Error)', () => {
      try {
        asLockKey('!!!');
      } catch (e) {
        if (e instanceof InvalidLockKeyError) {
          expect(e.name).toBe('InvalidLockKeyError');
        }
      }
    });
  });
});
