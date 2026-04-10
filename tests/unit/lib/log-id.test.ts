/**
 * hashId() unit test (observability.md § 3 — log-correlation stability).
 *
 * The contract this test pins:
 *   1. Deterministic: same input always produces the same output.
 *      This is the ONLY reason this helper exists — log aggregators
 *      use it to join lines for the same user across deployments.
 *   2. Short hex output, no prefix.
 *   3. Non-crashing on edge inputs (empty string, unicode).
 *   4. Distinct outputs for distinct inputs in the normal case.
 *
 * If a refactor changes the djb2 algorithm (e.g., `33` → `31` or
 * signed vs unsigned coercion), the first assertion will fail with
 * a pinned hex value, preventing a silent log-correlation break.
 */
import { describe, expect, it } from 'vitest';
import { hashId } from '@/lib/log-id';

describe('hashId() — djb2 log-correlation hash', () => {
  it('produces a stable, pinned output for a known input', () => {
    // If this value changes, log correlation across deployments
    // breaks silently. Update ONLY if the algorithm is deliberately
    // rotated (and plan a deploy-coordinated flush of log filters).
    expect(hashId('abc')).toBe('b873285');
  });

  it('is deterministic across calls', () => {
    const a = hashId('user-00000000-0000-0000-0000-000000000001');
    const b = hashId('user-00000000-0000-0000-0000-000000000001');
    expect(a).toBe(b);
  });

  it('returns lowercase hex digits only', () => {
    const result = hashId('some-user-id');
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('does not throw on empty string', () => {
    expect(() => hashId('')).not.toThrow();
    // djb2 seed is 5381 → hex "1505"
    expect(hashId('')).toBe('1505');
  });

  it('produces distinct outputs for distinct inputs', () => {
    const a = hashId('alice@swecham.test');
    const b = hashId('bob@swecham.test');
    expect(a).not.toBe(b);
  });

  it('handles unicode (Thai email) without throwing', () => {
    expect(() => hashId('สมาชิก@swecham.test')).not.toThrow();
    const result = hashId('สมาชิก@swecham.test');
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it('output length is always ≤ 8 chars (unsigned 32-bit hex)', () => {
    // `>>> 0` caps the integer at 32 bits unsigned → max 0xFFFFFFFF
    // → 8 hex chars. Shorter outputs are padding-free (no leading 0).
    const samples = [
      '',
      'a',
      'some-user',
      '00000000-0000-0000-0000-000000000001',
      'very-long-user-identifier-with-many-characters-to-stress-test',
    ];
    for (const s of samples) {
      expect(hashId(s).length).toBeLessThanOrEqual(8);
    }
  });
});
