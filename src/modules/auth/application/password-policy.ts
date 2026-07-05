/**
 * Password strength + breach policy (T039, security.md T-11).
 *
 * Rules (in order):
 *   1. Minimum length: 12 characters (NIST SP 800-63B 2024 update)
 *   2. Must not be one of a small known-bad list
 *   3. Must not appear in HaveIBeenPwned breach corpus
 *      (k-anonymity API — only first 5 SHA-1 chars are sent)
 *
 * **Fails open on HIBP error**: if HIBP is unreachable, we accept the
 * password with a logged warning. The argument is that breach checks
 * are an additional defense; the rest of the policy (length, common
 * passwords) still applies. Constitution VIII prefers degraded service
 * over total outage during a third-party incident.
 *
 * Pure-ish: imports the logger but no Drizzle/Next/React. Lives in
 * application/ rather than infrastructure/ because it composes
 * application-level rules over an external service call.
 */
import { createHash } from 'node:crypto';
import { logger } from '@/lib/logger';

export type PasswordPolicyError =
  | { readonly code: 'too-short'; readonly minLength: number }
  | { readonly code: 'common-password' }
  | { readonly code: 'breached'; readonly occurrences: number };

export interface PasswordPolicyResult {
  readonly ok: boolean;
  readonly errors: readonly PasswordPolicyError[];
  /** 'weak' | 'acceptable' | 'strong' — drives the on-screen indicator. */
  readonly strength: 'weak' | 'acceptable' | 'strong';
}

export const MIN_PASSWORD_LENGTH = 12;

const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '123456789012',
  'qwerty123456',
  'changeme1234',
  'letmein12345',
  'admin1234567',
  'welcome12345',
  'iloveyou1234',
]);

/**
 * Decide whether a candidate password may be used. Pure async function;
 * the only side effect is a structured log line on HIBP failure.
 */
export async function checkPasswordPolicy(
  password: string,
): Promise<PasswordPolicyResult> {
  const errors: PasswordPolicyError[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push({ code: 'too-short', minLength: MIN_PASSWORD_LENGTH });
  }

  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push({ code: 'common-password' });
  }

  // HIBP k-anonymity check — fails open on network error.
  if (errors.length === 0) {
    const breachCount = await checkHibp(password);
    if (breachCount > 0) {
      errors.push({ code: 'breached', occurrences: breachCount });
    }
  }

  const strength = scoreStrength(password, errors);
  return { ok: errors.length === 0, errors, strength };
}

function scoreStrength(
  password: string,
  errors: readonly PasswordPolicyError[],
): 'weak' | 'acceptable' | 'strong' {
  if (errors.length > 0) return 'weak';
  // Keep in lockstep with the client `estimatePasswordStrength`
  // (src/components/auth/password-strength.tsx). Strong = >= 16 chars (length
  // alone) OR >= 12 chars (guaranteed here — shorter passwords already errored
  // as too-short above) with >= 3 of the 4 character classes. BUG-004: the old
  // rule required >= 16 chars AND a symbol, so a strong mixed 12-14 char
  // password only ever scored 'acceptable'.
  if (
    password.length >= 16 ||
    characterClassCount(password) >= MIN_STRONG_CHARACTER_CLASSES
  ) {
    return 'strong';
  }
  return 'acceptable';
}

/** Minimum character classes (of lower/upper/digit/symbol) for a short 'strong'. */
const MIN_STRONG_CHARACTER_CLASSES = 3;

/** How many of the 4 character classes (lower/upper/digit/symbol) appear. */
function characterClassCount(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) n += 1;
  if (/[A-Z]/.test(password)) n += 1;
  if (/[0-9]/.test(password)) n += 1;
  if (/[^a-zA-Z0-9]/.test(password)) n += 1;
  return n;
}

/**
 * Map a policy failure to the metric bucket documented in
 * observability.md § 4.5 `auth_password_weak_rejected_total` labels.
 *
 * The buckets are deliberately coarser than the policy error codes:
 *   - `short`  → password shorter than MIN_PASSWORD_LENGTH
 *   - `pwned`  → common-password list OR HaveIBeenPwned breach
 *   - `null`   → no mappable bucket (caller should not increment)
 *
 * Both `common-password` and `breached` collapse into `pwned`
 * because (a) they share the same remediation ("pick a different
 * one") and (b) we don't want dashboards to leak HIBP presence
 * through a distinct bucket name.
 *
 * Returns `null` when the first error is unmappable, so callers
 * can choose to skip the metric entirely rather than emit a
 * nonsense label.
 */
export function weakPasswordMetricBucket(
  errors: readonly PasswordPolicyError[],
): 'short' | 'pwned' | null {
  const first = errors[0]?.code;
  if (first === 'too-short') return 'short';
  if (first === 'common-password' || first === 'breached') return 'pwned';
  return null;
}

/**
 * Query HaveIBeenPwned's k-anonymity API. Sends only the first 5
 * characters of the SHA-1 hash; the response is a list of suffixes that
 * match — we look up our suffix locally.
 *
 * Returns the breach count (0 = clean, >0 = pwned). Returns 0 on
 * network error after logging a warning (fail open).
 */
async function checkHibp(password: string): Promise<number> {
  try {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'swecham-membership-f1' },
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      logger.warn(
        { status: response.status },
        'HIBP returned non-200 — failing open on breach check',
      );
      return 0;
    }

    const text = await response.text();
    for (const line of text.split('\n')) {
      const [lineSuffix, countStr] = line.trim().split(':');
      if (lineSuffix === suffix && countStr) {
        const count = Number.parseInt(countStr, 10);
        return Number.isFinite(count) ? count : 0;
      }
    }
    return 0;
  } catch (error) {
    logger.warn(
      { err: error },
      'HIBP unreachable — failing open on breach check (security.md T-11)',
    );
    return 0;
  }
}
