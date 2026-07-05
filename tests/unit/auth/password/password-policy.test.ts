/**
 * T040 — Password policy unit tests with mocked HIBP.
 *
 * Covers four scenarios per security.md T-11:
 *   1. too short → rejected
 *   2. pwned (HIBP returns a hit) → rejected
 *   3. clean (HIBP returns no hit) → accepted
 *   4. HIBP down → accepted (fail-open)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  checkPasswordPolicy,
  weakPasswordMetricBucket,
  type PasswordPolicyError,
} from '@/modules/auth/application/password-policy';

const originalFetch = global.fetch;

describe('checkPasswordPolicy', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('rejects passwords shorter than the minimum', async () => {
    const result = await checkPasswordPolicy('short');
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({
      code: 'too-short',
      minLength: MIN_PASSWORD_LENGTH,
    });
    expect(result.strength).toBe('weak');
  });

  it('rejects common passwords', async () => {
    // 'qwerty123456' is in the COMMON_PASSWORDS allow-list and is exactly
    // 12 chars (min length) so the common-password rule fires before HIBP.
    // No fetch mock needed because the HIBP guard short-circuits when
    // errors.length > 0.
    const result = await checkPasswordPolicy('qwerty123456');
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ code: 'common-password' });
  });

  it('rejects passwords found in HIBP corpus', async () => {
    // Mock HIBP returning a match. The API returns lines of the form
    // <SHA1_SUFFIX>:<COUNT>. We compute the suffix the policy will look up.
    const password = 'this-is-a-strong-but-pwned-pw-2026';
    const sha1 = await sha1Hex(password);
    const suffix = sha1.slice(5);

    global.fetch = vi.fn().mockResolvedValue(
      new Response(`${suffix}:42\nDEADBEEFDEADBEEF:1\n`, { status: 200 }),
    ) as typeof fetch;

    const result = await checkPasswordPolicy(password);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual({ code: 'breached', occurrences: 42 });
  });

  it('accepts a strong, clean password (HIBP returns no match)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('DEADBEEFDEADBEEFDEADBEEFDEADBEEF:1\n', { status: 200 }),
    ) as typeof fetch;

    const result = await checkPasswordPolicy('uncommon-passphrase-xyz-2026!');
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.strength).toBe('strong');
  });

  // BUG-004: keep scoreStrength in lockstep with the client estimator. Strong =
  // >= 16 chars (length alone) OR >= 12 chars with >= 3 character classes.
  it('scores a 12-char password with ≥3 character classes as strong — BUG-004', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('DEADBEEFDEADBEEFDEADBEEFDEADBEEF:1\n', { status: 200 }),
    ) as typeof fetch;
    // 12 chars, lower + upper + digit (3 classes) — used to score 'acceptable'.
    const result = await checkPasswordPolicy('MyPassw0rd12');
    expect(result.ok).toBe(true);
    expect(result.strength).toBe('strong');
  });

  it('scores a 16-char password as strong on length alone, no symbol needed — BUG-004', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('DEADBEEFDEADBEEFDEADBEEFDEADBEEF:1\n', { status: 200 }),
    ) as typeof fetch;
    const result = await checkPasswordPolicy('abcdefghijklmnop'); // 16, lower only
    expect(result.ok).toBe(true);
    expect(result.strength).toBe('strong');
  });

  it('scores a short password with < 3 character classes as acceptable', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response('DEADBEEFDEADBEEFDEADBEEFDEADBEEF:1\n', { status: 200 }),
    ) as typeof fetch;
    const result = await checkPasswordPolicy('averylonglower'); // 14, lower only (1 class)
    expect(result.ok).toBe(true);
    expect(result.strength).toBe('acceptable');
  });

  it('accepts password when HIBP is unreachable (fail-open per T-11)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down'));

    const result = await checkPasswordPolicy('uncommon-passphrase-xyz-2026!');
    expect(result.ok).toBe(true);
    expect(result.strength).toBe('strong');
  });

  it('accepts password when HIBP returns 5xx (fail-open)', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 503 }));

    const result = await checkPasswordPolicy('uncommon-passphrase-xyz-2026!');
    expect(result.ok).toBe(true);
  });
});

// Helper: replicate the same SHA-1 the policy uses, so the test sets up
// a matching mock response.
async function sha1Hex(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha1').update(input, 'utf8').digest('hex').toUpperCase();
}

describe('weakPasswordMetricBucket', () => {
  it('returns "short" when the first error is too-short', () => {
    const errors: PasswordPolicyError[] = [
      { code: 'too-short', minLength: 12 },
    ];
    expect(weakPasswordMetricBucket(errors)).toBe('short');
  });

  it('returns "pwned" when the first error is common-password', () => {
    // `common-password` (locally matched via COMMON_PASSWORDS set)
    // intentionally aliases to the `'pwned'` metric bucket, NOT a
    // separate `'common'` bucket. Both signals mean "password reuse"
    // on the operator dashboard, and distinguishing them would leak
    // information about which branch caught the password.
    const errors: PasswordPolicyError[] = [{ code: 'common-password' }];
    expect(weakPasswordMetricBucket(errors)).toBe('pwned');
  });

  it('returns "pwned" when the first error is breached', () => {
    const errors: PasswordPolicyError[] = [
      { code: 'breached', occurrences: 42 },
    ];
    expect(weakPasswordMetricBucket(errors)).toBe('pwned');
  });

  it('returns null for an empty error list (defensive — caller should skip the metric)', () => {
    expect(weakPasswordMetricBucket([])).toBe(null);
  });

  it('uses ONLY the first error — does not inspect the tail', () => {
    const errors: PasswordPolicyError[] = [
      { code: 'too-short', minLength: 12 },
      { code: 'breached', occurrences: 99 },
    ];
    // First is too-short → 'short', regardless of the trailing breached entry.
    expect(weakPasswordMetricBucket(errors)).toBe('short');
  });
});
