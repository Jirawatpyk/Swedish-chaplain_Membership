/**
 * F8 Phase 6 round-3 I1 fix — locale-aware plan-name resolver.
 *
 * Extracted from `page.tsx` (Phase 5 Wave C T125) so the locale
 * fallback chain is unit-testable in isolation. Mirrors the
 * cycle-detail `_lib/cycle-detail-fetchers.ts` pattern.
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
