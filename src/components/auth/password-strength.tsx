'use client';

/**
 * PasswordStrength indicator (T105, ux-standards § 11.4).
 *
 * Three-segment bar driven by the strength score from
 * `checkPasswordPolicy()`. The component is purely presentational —
 * it does NOT run the policy itself because that requires a HIBP
 * network call (fail-open) and k-anonymity hashing, which only make
 * sense after the user stops typing. The parent form is expected to
 * compute strength via its own throttled effect and pass the result
 * down.
 *
 * Accessibility:
 *   - aria-live="polite" so screen readers announce strength changes
 *     without stealing focus
 *   - Colour is paired with a text label so the message is legible to
 *     colour-blind users
 */
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

export type PasswordStrengthLevel = 'weak' | 'acceptable' | 'strong' | 'empty';

export interface PasswordStrengthProps {
  readonly level: PasswordStrengthLevel;
}

/**
 * Lightweight client-side strength estimator — used by every
 * password-entering form to drive the `<PasswordStrength />` bar
 * while the user types. Does NOT replace the server-side
 * `checkPasswordPolicy` (length + common-list + HIBP) which runs on
 * submit and is the authoritative gate.
 *
 * Rules approximate the server `scoreStrength` in
 * `src/modules/auth/application/password-policy.ts`:
 *   - empty  → no bar
 *   - <12 chars → weak
 *   - obvious low-entropy junk (≤3 distinct characters —
 *     e.g. "111111111111") → weak. This is a best-effort local guard,
 *     NOT a security control: such inputs are very likely (not certain)
 *     to be in the HIBP breach corpus, which only the server can check,
 *     so flagging them keeps the bar from being falsely encouraging. It
 *     does not approximate the curated common-list, whose 10 entries are
 *     a disjoint set the client can't see.
 *   - ≥16 chars AND has a non-alphanumeric → strong
 *   - otherwise → acceptable
 *
 * **Known client/server drift** (accepted trade-off) — in BOTH
 * directions:
 *   - *client green / server red*: the client cannot replicate the HIBP
 *     breach check without a network round-trip on every keystroke, so a
 *     16+ char password with a symbol that happens to be in the HIBP
 *     corpus shows a green bar but is rejected by the server with
 *     `{ error: 'weak-password', issues: ['breached'] }`.
 *   - *client red / server (maybe) green*: the low-entropy guard above
 *     is deliberately STRICTER than `scoreStrength`, which has no entropy
 *     check. Because the HIBP gate fails open on an outage, a low-variety
 *     12+ char string can score 'acceptable' on the server while the
 *     client shows 'weak'. This is the safe direction — the client only
 *     ever demotes a score, never upgrades it.
 *
 * On a server rejection the three forms surface the inline error via
 * `setError(passwordField, …)` + `setFocus(...)` — `change-password-form`
 * and `reset-password-form` use the `newPassword` field, `invite-redeem-form`
 * uses `password`. They do NOT clear the field, so the bar is not
 * auto-reset; it re-evaluates only as the user edits the watched value.
 *
 * Previously duplicated verbatim in `change-password-form.tsx`,
 * `invite-redeem-form.tsx`, and `reset-password-form.tsx`. A rule
 * tweak (e.g. length threshold) now lives in exactly one place.
 */
export function estimatePasswordStrength(
  password: string,
): PasswordStrengthLevel {
  if (password.length === 0) return 'empty';
  if (password.length < 12) return 'weak';
  // Obvious low-entropy junk (≤3 distinct characters, e.g. "111111111111" or
  // "121212121212") is very likely to be in the HIBP corpus the server checks.
  // Flag it locally — no network round-trip — so the bar never reads
  // "acceptable" for it (see the client/server-drift note above).
  if (isLowEntropy(password)) return 'weak';
  if (password.length >= 16 && /[^a-zA-Z0-9]/.test(password)) return 'strong';
  return 'acceptable';
}

/** Distinct-character floor below which a password counts as trivially weak. */
const MAX_LOW_ENTROPY_DISTINCT = 3;

/**
 * Trivially-weak patterns detectable locally, without the HIBP network call.
 * `new Set(...)` spreads by code point, so a single repeated character — and
 * even a repeated emoji (one grapheme → size 1) that a UTF-16 regex would miss
 * — collapses to a tiny distinct-character count.
 */
function isLowEntropy(password: string): boolean {
  return new Set(password).size <= MAX_LOW_ENTROPY_DISTINCT;
}

const SEGMENT_COUNT = 3;

function activeSegments(level: PasswordStrengthLevel): number {
  switch (level) {
    case 'strong':
      return 3;
    case 'acceptable':
      return 2;
    case 'weak':
      return 1;
    case 'empty':
    default:
      return 0;
  }
}

function barColour(level: PasswordStrengthLevel): string {
  switch (level) {
    case 'strong':
      return 'bg-success';
    case 'acceptable':
      return 'bg-warning';
    case 'weak':
      return 'bg-destructive';
    case 'empty':
    default:
      return 'bg-muted';
  }
}

export function PasswordStrength({ level }: PasswordStrengthProps) {
  const t = useTranslations('auth.passwordStrength');
  const filled = activeSegments(level);
  const colour = barColour(level);

  return (
    <div className="space-y-1" aria-live="polite">
      <div className="flex gap-1.5">
        {Array.from({ length: SEGMENT_COUNT }, (_, index) => (
          <div
            key={index}
            className={cn(
              'h-1.5 flex-1 rounded-full transition-colors',
              index < filled ? colour : 'bg-muted',
            )}
          />
        ))}
      </div>
      {level !== 'empty' ? (
        <p className="text-xs text-muted-foreground">{t(level)}</p>
      ) : null}
    </div>
  );
}
