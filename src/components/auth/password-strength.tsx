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
 * Rules (matches the server heuristic in
 * `src/modules/auth/application/password-policy.ts scoreStrength`):
 *   - empty  → no bar
 *   - <12 chars → weak
 *   - ≥16 chars AND has a non-alphanumeric → strong
 *   - otherwise → acceptable
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
  if (password.length >= 16 && /[^a-zA-Z0-9]/.test(password)) return 'strong';
  return 'acceptable';
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
      return 'bg-emerald-500';
    case 'acceptable':
      return 'bg-amber-500';
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
