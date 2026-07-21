/**
 * Locale-aware plan-name resolver (promoted from the portal renewal
 * route `_lib/` so admin + portal surfaces share ONE resolver).
 *
 * Originally extracted from the portal renewal `page.tsx` (F8 Phase 6
 * round-3 I1) so the locale fallback chain is unit-testable in isolation.
 * Promoted to `src/lib/` (plan-change UX remediation, P1-8) because the
 * admin invoice-create + member-form surfaces were hardcoding
 * `plan_name.en` — losing TH/SV for the exact same JSONB shape. One
 * resolver, one fallback chain, three surfaces.
 *
 * Behaviour:
 *   - locale='th' + th present + non-empty → return th
 *   - locale='sv' + sv present + non-empty → return sv
 *   - any locale + missing/empty localised key → return en
 *   - en missing → return `fallback` (typically the plan slug)
 *   - rawName not an object → return String(rawName ?? fallback)
 *
 * Note: matches `LocaleText` shape `{ en: string; th?: string; sv?: string }`
 * from `@/modules/plans` but accepts `unknown` to handle JSONB rows
 * that may have extra fields or wrong types (defensive parsing).
 */
import type { LocaleText } from '@/modules/plans';

export function resolvePlanName(
  rawName: unknown,
  fallback: string,
  locale: string,
): string {
  if (typeof rawName === 'object' && rawName !== null) {
    const localeText = rawName as LocaleText;
    return (
      (locale === 'th' && localeText.th) ||
      (locale === 'sv' && localeText.sv) ||
      localeText.en ||
      fallback
    );
  }
  return String(rawName ?? fallback);
}
