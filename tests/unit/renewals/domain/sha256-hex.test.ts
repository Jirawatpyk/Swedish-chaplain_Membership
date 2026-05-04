/**
 * F8 Round 4 — `Sha256Hex` value-object tests.
 *
 * Locks the regex contract for `parseSha256Hex` so a future regression
 * (e.g., losing the `^…$` anchors, accepting invalid lengths, breaking
 * the canonical lowercase normalisation) surfaces here rather than in
 * production audit forensics where it would silently corrupt the hash
 * comparison invariant.
 */
import { describe, expect, it } from 'vitest';
import {
  asSha256Hex,
  parseSha256Hex,
} from '@/modules/renewals/domain/value-objects/sha256-hex';

const VALID_64_LOWER = 'a'.repeat(64);
const VALID_64_UPPER = 'A'.repeat(64);
const VALID_MIXED_CASE = 'aB'.repeat(32);

describe('Sha256Hex.asSha256Hex (unchecked cast)', () => {
  it('returns the input unchanged (identity at runtime)', () => {
    expect(asSha256Hex('whatever')).toBe('whatever');
  });
});

describe('Sha256Hex.parseSha256Hex', () => {
  it('accepts canonical 64-lowercase-hex', () => {
    const r = parseSha256Hex(VALID_64_LOWER);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_64_LOWER);
  });

  it('accepts sha256:-prefixed canonical hash', () => {
    const r = parseSha256Hex(`sha256:${VALID_64_LOWER}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(`sha256:${VALID_64_LOWER}`);
  });

  it('lowercase-normalises uppercase input (canonical equality invariant)', () => {
    const r = parseSha256Hex(VALID_64_UPPER);
    expect(r.ok).toBe(true);
    // Regression guard: equality vs `crypto.createHash('sha256').digest('hex')`
    // returns lowercase — if we stored uppercase we would silently mismatch.
    if (r.ok) expect(r.value).toBe(VALID_64_LOWER);
  });

  it('lowercase-normalises mixed-case input', () => {
    const r = parseSha256Hex(VALID_MIXED_CASE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(VALID_MIXED_CASE.toLowerCase());
  });

  it('rejects 63-hex (one short)', () => {
    const r = parseSha256Hex('a'.repeat(63));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_sha256_hex');
  });

  it('rejects 65-hex (one over)', () => {
    const r = parseSha256Hex('a'.repeat(65));
    expect(r.ok).toBe(false);
  });

  it('rejects empty string', () => {
    const r = parseSha256Hex('');
    expect(r.ok).toBe(false);
  });

  it('rejects non-hex characters (g-z)', () => {
    const r = parseSha256Hex('g'.repeat(64));
    expect(r.ok).toBe(false);
  });

  it('rejects sha256:-prefix with too-short body', () => {
    const r = parseSha256Hex(`sha256:${'a'.repeat(63)}`);
    expect(r.ok).toBe(false);
  });

  it('rejects unanchored input (no padding tolerated)', () => {
    const r = parseSha256Hex(`x${VALID_64_LOWER}x`);
    expect(r.ok).toBe(false);
  });

  it('rejects non-string input', () => {
    const r = parseSha256Hex(42 as unknown as string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_sha256_hex');
  });

  it('rejects null / undefined', () => {
    expect(parseSha256Hex(null as unknown as string).ok).toBe(false);
    expect(parseSha256Hex(undefined as unknown as string).ok).toBe(false);
  });
});
