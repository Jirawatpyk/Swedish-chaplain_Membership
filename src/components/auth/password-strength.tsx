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
 * `checkPasswordPolicy` (HIBP + common-list) which runs on submit.
 *
 * Rules approximate the server `scoreStrength` in
 * `src/modules/auth/application/password-policy.ts`:
 *   - empty  → no bar
 *   - <12 chars → weak
 *   - obvious low-entropy junk (one repeated char, or ≤3 distinct
 *     chars — e.g. "111111111111") → weak. This is a local
 *     approximation of what the server's HIBP/common-list check will
 *     reject, so the bar isn't falsely encouraging.
 *   - ≥16 chars AND has a non-alphanumeric → strong
 *   - otherwise → acceptable
 *
 * **Known client/server drift** (accepted trade-off): the client
 * cannot replicate the HIBP breach check without making a network
 * round-trip on every keystroke. A 16+ character password with a
 * symbol that happens to be in the HIBP corpus will show a green
 * bar on the client but will be rejected by the server with
 * `{ error: 'weak-password', issues: ['breached'] }`. The three
 * password forms MUST handle that response by showing the inline
 * error AND resetting the displayed bar — `change-password-form`,
 * `reset-password-form`, and `invite-redeem-form` all do this via
 * their `setError('newPassword', …)` + re-render path (the bar is
 * driven by the form's watched value; clearing or re-typing will
 * re-run this estimator).
 *
 * The client/server drift is documented in
 * `docs/ux-standards.md § 11.4` as a deliberate choice.
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
  // Obvious low-entropy junk (a single repeated character, or ≤3 distinct
  // characters) is near-certain to be in the HIBP corpus and rejected on
  // submit. Flag it locally so the bar never reads "acceptable" for e.g.
  // "111111111111" — this needs no network round-trip, unlike the full breach
  // check which stays server-side (see the client/server-drift note above).
  if (isLowEntropy(password)) return 'weak';
  if (password.length >= 16 && /[^a-zA-Z0-9]/.test(password)) return 'strong';
  return 'acceptable';
}

/** Trivially-weak patterns detectable locally, without the HIBP network call. */
function isLowEntropy(password: string): boolean {
  if (/^(.)\1+$/.test(password)) return true; // one repeated character
  return new Set(password).size <= 3; // too few distinct characters
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
