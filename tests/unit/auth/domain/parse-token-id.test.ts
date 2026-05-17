/**
 * N3 (Round 3) — validating token parsers.
 *
 * `parseResetTokenId` and `parseInvitationTokenId` are the trust-
 * boundary functions that gate every reset / redeem URL request.
 * Pre-N3 these had ZERO unit tests; a regex refactor or a removed
 * length check would have passed CI silently. This file pins:
 *   - valid 64-hex lowercase → returns the branded value
 *   - 63-hex / 65-hex / empty → throws MalformedTokenError
 *   - non-hex chars / whitespace → throws
 *   - N5 (Round 3) bonus: uppercase hex is normalised to lowercase
 *     and PASSES (handles email-gateway URL rewrites)
 */
import { describe, expect, it } from 'vitest';
import {
  MalformedTokenError,
  parseInvitationTokenId,
  parseResetTokenId,
  isHex64,
} from '@/modules/auth/domain/branded';

const VALID_HEX = 'a'.repeat(64);
const VALID_MIXED = 'a1b2c3d4e5f6'.repeat(5) + 'a1b2'; // 64 chars

describe('parseResetTokenId', () => {
  it('accepts valid 64-char lowercase hex', () => {
    const result = parseResetTokenId(VALID_HEX);
    expect(typeof result).toBe('string');
    expect(result).toBe(VALID_HEX);
  });

  it('accepts mixed lowercase hex digits', () => {
    const result = parseResetTokenId(VALID_MIXED);
    expect(result).toBe(VALID_MIXED);
  });

  it('normalises uppercase hex to lowercase (N5 — email-gateway rewrites)', () => {
    const result = parseResetTokenId('A'.repeat(64));
    expect(result).toBe('a'.repeat(64));
  });

  it('normalises mixed-case hex to lowercase', () => {
    const result = parseResetTokenId('AbCdEf' + 'a'.repeat(58));
    expect(result).toBe('abcdef' + 'a'.repeat(58));
  });

  it('throws MalformedTokenError on 63-char hex (too short)', () => {
    expect(() => parseResetTokenId('a'.repeat(63))).toThrow(
      MalformedTokenError,
    );
  });

  it('throws on 65-char hex (too long)', () => {
    expect(() => parseResetTokenId('a'.repeat(65))).toThrow(
      MalformedTokenError,
    );
  });

  it('throws on empty string', () => {
    expect(() => parseResetTokenId('')).toThrow(MalformedTokenError);
  });

  it('throws on non-hex char (g)', () => {
    expect(() => parseResetTokenId('g' + 'a'.repeat(63))).toThrow(
      MalformedTokenError,
    );
  });

  it('throws on hyphen / special char', () => {
    expect(() => parseResetTokenId('-' + 'a'.repeat(63))).toThrow(
      MalformedTokenError,
    );
  });

  it('throws on whitespace-padded input', () => {
    expect(() => parseResetTokenId(' ' + 'a'.repeat(63))).toThrow(
      MalformedTokenError,
    );
  });

  it('error message includes brand name + actual length', () => {
    try {
      parseResetTokenId('short');
    } catch (e) {
      expect(e).toBeInstanceOf(MalformedTokenError);
      expect((e as Error).message).toContain('ResetTokenId');
      // S6 (Round 4) — word-boundary regex so a future message
      // rewrite that contains other literal digits cannot mask
      // a length-mismatch regression.
      expect((e as Error).message).toMatch(/got length 5\b/);
      return;
    }
    throw new Error('expected throw');
  });
});

describe('parseInvitationTokenId', () => {
  it('accepts valid 64-char lowercase hex', () => {
    expect(parseInvitationTokenId(VALID_HEX)).toBe(VALID_HEX);
  });

  it('normalises uppercase to lowercase (N5)', () => {
    expect(parseInvitationTokenId('A'.repeat(64))).toBe('a'.repeat(64));
  });

  it('throws MalformedTokenError on too-short input', () => {
    expect(() => parseInvitationTokenId('a'.repeat(63))).toThrow(
      MalformedTokenError,
    );
  });

  it('throws on non-hex char', () => {
    expect(() => parseInvitationTokenId('z' + 'a'.repeat(63))).toThrow(
      MalformedTokenError,
    );
  });

  it('error message brands the InvitationTokenId namespace', () => {
    try {
      parseInvitationTokenId('short');
    } catch (e) {
      expect((e as Error).message).toContain('InvitationTokenId');
      return;
    }
    throw new Error('expected throw');
  });
});

describe('isHex64 predicate', () => {
  it('returns true for valid 64-char lowercase hex', () => {
    expect(isHex64('a'.repeat(64))).toBe(true);
  });

  it('returns false for uppercase (case-sensitive at predicate layer)', () => {
    // Note: parseResetTokenId / parseInvitationTokenId lowercase BEFORE
    // calling isHex64 internally; the predicate itself is strict.
    expect(isHex64('A'.repeat(64))).toBe(false);
  });

  it('returns false for short / long / non-hex input', () => {
    expect(isHex64('a'.repeat(63))).toBe(false);
    expect(isHex64('a'.repeat(65))).toBe(false);
    expect(isHex64('')).toBe(false);
    expect(isHex64('z' + 'a'.repeat(63))).toBe(false);
  });
});
