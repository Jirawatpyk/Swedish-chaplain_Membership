/**
 * Round 2 T-Gap4 fix (2026-05-13) — unit tests for the
 * `SecretLastFour` brand smart-constructor (`asSecretLastFour`).
 *
 * The `length < 4` throw branch (`src/modules/events/domain/secret-
 * last-four.ts:30-33`) was previously untested. Production secrets
 * are always ≥40 chars base64url, so the throw is purely defensive,
 * but a 3-line guard test closes the agent-flagged Gap 4 and prevents
 * a future refactor that shortens the secret factory from silently
 * truncating audit `secretLastFour` fields.
 */
import { describe, expect, it } from 'vitest';
import {
  asSecretLastFour,
  type SecretLastFour,
} from '@/modules/events/domain/secret-last-four';

describe('asSecretLastFour smart-constructor', () => {
  it('returns the last 4 chars on a ≥4-char secret', () => {
    const v: SecretLastFour = asSecretLastFour('abcdef-1a2b');
    expect(v).toBe('1a2b');
  });

  it('returns the full 4-char string when input is exactly 4 chars', () => {
    expect(asSecretLastFour('abcd')).toBe('abcd');
  });

  it('throws on input shorter than 4 characters', () => {
    expect(() => asSecretLastFour('abc')).toThrow(/≥4/);
    expect(() => asSecretLastFour('')).toThrow(/≥4/);
  });

  it('throws on a 1-char input (clear boundary case)', () => {
    expect(() => asSecretLastFour('a')).toThrow(
      'asSecretLastFour: secret must be ≥4 chars, got 1',
    );
  });
});
