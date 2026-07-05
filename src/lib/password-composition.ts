/**
 * Shared password-composition helpers.
 *
 * The "Strong" threshold is applied by BOTH the client strength meter
 * (`src/components/auth/password-strength.tsx`) and the server policy
 * (`src/modules/auth/application/password-policy.ts`). It lives here — a
 * framework-free `lib/` module both layers may import — so the rule cannot
 * drift between client and server (the class of bug BUG-001 / BUG-004 caused,
 * previously guarded only by hand-maintained "keep in lockstep" comments).
 *
 * Pure: no framework, DB, or React imports.
 */

/** Minimum character classes (of lower/upper/digit/symbol) for a short 'strong'. */
export const MIN_STRONG_CHARACTER_CLASSES = 3;

/** How many of the 4 character classes (lower/upper/digit/symbol) appear. */
export function characterClassCount(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) n += 1;
  if (/[A-Z]/.test(password)) n += 1;
  if (/[0-9]/.test(password)) n += 1;
  if (/[^a-zA-Z0-9]/.test(password)) n += 1;
  return n;
}

/**
 * The shared "strong composition" rule (BUG-004): a password counts as strong
 * when it is long enough on its own (>= 16 chars — e.g. a passphrase) OR
 * shorter but varied (>= 3 of the 4 character classes). Callers apply their own
 * disqualifiers first (too-short, low-entropy, policy errors); this only
 * decides strong-vs-acceptable for an otherwise-passing password.
 */
export function hasStrongComposition(password: string): boolean {
  return (
    password.length >= 16 ||
    characterClassCount(password) >= MIN_STRONG_CHARACTER_CLASSES
  );
}
