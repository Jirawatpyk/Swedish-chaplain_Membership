/**
 * Unit tests for src/modules/members/application/crypto-helpers.ts
 *
 * Covers:
 *   - TTL constants have the expected millisecond values (regression guard
 *     against accidental edits that would widen/shrink the FR-012a windows)
 *   - generateToken returns a distinct hex plaintext + matching sha256 hash
 *   - hashEmail normalises case (audit log lookups depend on this)
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateToken,
  hashEmail,
  VERIFICATION_ACTIVATION_DELAY_MS,
  VERIFICATION_TOKEN_TTL_MS,
  REVERT_TOKEN_TTL_MS,
} from '@/modules/members/application/crypto-helpers';

describe('crypto-helpers: TTL constants', () => {
  it('VERIFICATION_ACTIVATION_DELAY_MS = 5 minutes', () => {
    expect(VERIFICATION_ACTIVATION_DELAY_MS).toBe(5 * 60 * 1000);
  });

  it('VERIFICATION_TOKEN_TTL_MS = 24 hours', () => {
    expect(VERIFICATION_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('REVERT_TOKEN_TTL_MS = 48 hours', () => {
    expect(REVERT_TOKEN_TTL_MS).toBe(48 * 60 * 60 * 1000);
  });
});

describe('crypto-helpers: generateToken', () => {
  it('returns a 64-character hex plaintext (32 random bytes)', () => {
    const { plaintext } = generateToken();
    expect(plaintext).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a sha256 hash that matches the plaintext', () => {
    const { plaintext, hash } = generateToken();
    const expected = createHash('sha256').update(plaintext).digest('hex');
    expect(hash).toBe(expected);
  });

  it('produces distinct tokens across calls', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('crypto-helpers: hashEmail', () => {
  it('hashes a lowercase email deterministically', () => {
    const h1 = hashEmail('user@example.com');
    const h2 = hashEmail('user@example.com');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('case-normalises before hashing (upper = lower)', () => {
    expect(hashEmail('USER@EXAMPLE.COM')).toBe(hashEmail('user@example.com'));
    expect(hashEmail('User@Example.Com')).toBe(hashEmail('user@example.com'));
  });

  it('produces different hashes for different addresses', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'));
  });

  it('matches an externally-computed SHA-256 of the lowercased input', () => {
    const email = 'MixedCase@EXAMPLE.com';
    const expected = createHash('sha256')
      .update(email.toLowerCase())
      .digest('hex');
    expect(hashEmail(email)).toBe(expected);
  });
});
