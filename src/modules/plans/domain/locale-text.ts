/**
 * `LocaleText` — structured multi-locale text for plan names + descriptions.
 *
 * F2 stores plan display names as `{ en, th?, sv? }` per Clarifications Q3:
 *   - `en` is REQUIRED at save time (missing EN key fails the build)
 *   - `th` and `sv` are OPTIONAL with a visible "missing translation"
 *     indicator in admin views
 *
 * The type lives in Domain so validators, policies, and presentation
 * components can all import it from `@/modules/plans`. The matching
 * zod schema lives in `plan-validators.ts` alongside the rest of the
 * Domain validation rules.
 *
 * Pure TypeScript — no framework imports.
 */

export type LocaleText = {
  readonly en: string;
  readonly th?: string;
  readonly sv?: string;
};

/** Supported locale keys — narrower than app-wide `next-intl` locales. */
export const LOCALE_KEYS = ['en', 'th', 'sv'] as const;
export type LocaleKey = (typeof LOCALE_KEYS)[number];

export class EmptyEnLocaleTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyEnLocaleTextError';
  }
}

/**
 * Smart constructor for `LocaleText` (post-ship R6 I9 / D4).
 *
 * Validates the empty-`en` invariant at the boundary — the existing
 * `localeTextSchema` zod validator in `plan-validators.ts` enforces
 * the same rule at the HTTP/API edge, but Domain code that bypasses
 * zod (test fixtures, seeders, future use-cases) was previously able
 * to construct `{ en: '' }` and slip an empty primary locale into
 * persistence. This constructor closes that gap.
 *

 * Use this for NEW Domain code that produces LocaleText values. UI
 * components and i18n renderers can continue to construct via object
 * literal — `LocaleText` is structural.
 */
export function asLocaleText(input: {
  readonly en: string;
  readonly th?: string;
  readonly sv?: string;
}): LocaleText {
  if (typeof input.en !== 'string' || input.en.trim().length === 0) {
    throw new EmptyEnLocaleTextError(
      'asLocaleText: `en` is required and must be a non-empty string',
    );
  }
  const out: { en: string; th?: string; sv?: string } = { en: input.en };
  if (input.th !== undefined) out.th = input.th;
  if (input.sv !== undefined) out.sv = input.sv;
  return out as LocaleText;
}

/**
 * Return the list of missing non-EN translations on a LocaleText record.
 * `en` is always required so it never appears in the result.
 *
 * Used by the admin list rendering to decide whether to show the
 * "missing translation" badge + by the i18n validator in the seed script.
 */
export function hasMissingTranslations(text: LocaleText): Array<Exclude<LocaleKey, 'en'>> {
  const missing: Array<Exclude<LocaleKey, 'en'>> = [];
  if (text.th === undefined || text.th.trim().length === 0) missing.push('th');
  if (text.sv === undefined || text.sv.trim().length === 0) missing.push('sv');
  return missing;
}

/**
 * Pick the value to render for the active locale, falling back to
 * English if the requested locale is missing. Returns a `{ value,
 * missing }` tuple so callers can decide whether to render the
 * missing-translation indicator.
 *
 * Fallback chain:
 *   - requested locale present → use it, `missing: false`
 *   - requested locale missing, `en` present → use `en`, `missing: true`
 *   - this function never returns an empty string (EN is required)
 */
export function pickLocaleText(
  text: LocaleText,
  activeLocale: LocaleKey,
): { value: string; missing: boolean } {
  if (activeLocale === 'en') {
    return { value: text.en, missing: false };
  }
  const candidate = text[activeLocale];
  if (candidate !== undefined && candidate.trim().length > 0) {
    return { value: candidate, missing: false };
  }
  return { value: text.en, missing: true };
}
