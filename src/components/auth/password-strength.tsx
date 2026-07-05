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
import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { hasStrongComposition } from '@/lib/password-composition';

export type PasswordStrengthLevel = 'weak' | 'acceptable' | 'strong' | 'empty';

/**
 * Why a 'weak' score was assigned, so the bar can show a reason-specific
 * caption instead of one generic line:
 *   - `tooShort`    → under the 12-char minimum
 *   - `lowVariety`  → long enough but ≤3 distinct characters
 *   - `rejected`    → the server rejected this exact value on submit
 *     (e.g. HIBP-breached); the bar is forced to red to match the inline error
 */
export type PasswordWeakReason = 'tooShort' | 'lowVariety' | 'rejected';

export interface PasswordStrengthProps {
  readonly level: PasswordStrengthLevel;
  /** Only consulted when `level === 'weak'`; picks the reason-specific caption. */
  readonly weakReason?: PasswordWeakReason | undefined;
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
 *   - ≥16 chars (length alone), OR ≥12 chars with ≥3 character classes
 *     (lower/upper/digit/symbol) → strong
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
 * uses `password`. They also call `markRejected(value)` from
 * `usePasswordStrengthMeter`, which forces the bar to 'weak' (red) for that
 * exact value so the meter agrees with the error instead of contradicting it
 * (no more green bar beside a "breached" message). The bar returns to the live
 * estimate as soon as the user edits the value.
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
  // Strong = long enough on its own (>= 16 chars) OR shorter-but-varied (>= 3
  // character classes) — the shared `hasStrongComposition` rule, kept in ONE
  // place so the client bar and the server `scoreStrength` cannot drift
  // (BUG-004 / BUG-001).
  if (hasStrongComposition(password)) {
    return 'strong';
  }
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

/**
 * Why `estimatePasswordStrength` would score this value 'weak' — for the
 * reason-specific caption. Returns `null` when the value is NOT weak by the
 * local rules (so callers map it to `undefined`).
 */
export function weakReasonFor(
  password: string,
): Exclude<PasswordWeakReason, 'rejected'> | null {
  if (password.length === 0) return null;
  if (password.length < 12) return 'tooShort';
  if (isLowEntropy(password)) return 'lowVariety';
  return null;
}

export interface PasswordStrengthMeter {
  readonly level: PasswordStrengthLevel;
  readonly weakReason: PasswordWeakReason | undefined;
  /** Pin the bar to 'weak' for `value` after the server rejects it on submit. */
  readonly markRejected: (value: string) => void;
  /** Drop the pin (e.g. after a successful change while the form stays mounted). */
  readonly clearRejected: () => void;
}

/**
 * Drives a `<PasswordStrength />` bar from the live field value, and lets the
 * form pin it to 'weak' when the server rejects that exact value — keeping the
 * meter from contradicting the inline error. Shared by all three password
 * forms so the behaviour stays identical.
 */
export function usePasswordStrengthMeter(password: string): PasswordStrengthMeter {
  const [rejectedValue, setRejectedValue] = useState<string | null>(null);
  const markRejected = useCallback(
    (value: string) => setRejectedValue(value),
    [],
  );
  const clearRejected = useCallback(() => setRejectedValue(null), []);

  // The pin only holds while the value equals the rejected one; any edit re-runs
  // the live estimate (a different string no longer matches `rejectedValue`).
  // The pin is value-equality, not a one-shot flag: if the user edits away and
  // then types their way back to the exact rejected value, the bar re-pins to
  // red without a new submit. That is intentional — that value was genuinely
  // rejected (e.g. HIBP-breached), so the server would reject it again.
  const rejected = rejectedValue !== null && rejectedValue === password;
  const level = rejected ? 'weak' : estimatePasswordStrength(password);
  const weakReason: PasswordWeakReason | undefined = rejected
    ? 'rejected'
    : level === 'weak'
      ? (weakReasonFor(password) ?? undefined)
      : undefined;

  return { level, weakReason, markRejected, clearRejected };
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

const WEAK_REASON_KEY: Record<PasswordWeakReason, string> = {
  tooShort: 'weakTooShort',
  lowVariety: 'weakLowVariety',
  rejected: 'weakRejected',
};

export function PasswordStrength({ level, weakReason }: PasswordStrengthProps) {
  const t = useTranslations('auth.passwordStrength');
  const filled = activeSegments(level);
  const colour = barColour(level);
  // Reason-specific caption for the weak case ('too short' vs 'low variety' vs
  // server-rejected); falls back to the generic `weak` key when no reason is
  // supplied, and to the level key for acceptable/strong.
  const messageKey =
    level === 'weak' && weakReason ? WEAK_REASON_KEY[weakReason] : level;

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
        <p className="text-xs text-muted-foreground">{t(messageKey)}</p>
      ) : null}
    </div>
  );
}
