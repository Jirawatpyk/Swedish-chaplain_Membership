import { type Locale } from './config';

/**
 * Named dateTime format presets for next-intl.
 *
 * `th` gets `calendar: 'buddhist'` explicitly so all `format.dateTime(d, 'preset')`
 * calls render Buddhist-Era years without relying on ICU's fragile bare-'th' default.
 * `en` and `sv` use Gregorian (no calendar override).
 *
 * Exported for unit-testing: `buildFormats('th').dateTime.dateMedium` must include
 * `calendar: 'buddhist'` and produce BE years (e.g. 2026 CE → 2569 BE).
 *
 * Return type is intentionally inferred (not annotated) so it preserves the precise
 * literal types needed by the AppConfig augmentation in `src/i18n/next-intl.d.ts`.
 * A manual `Record<string, Intl.DateTimeFormatOptions>` annotation would widen the
 * return type and prevent the augmentation from deriving the exact key union.
 *
 * Both locale branches are constrained with `satisfies Record<DateTimePresetKey, object>`
 * so that a missing or extra key is a compile error, while the inferred literal types
 * (narrow `'buddhist'`, `'short'`, etc.) are preserved.  We use `object` rather than
 * `Intl.DateTimeFormatOptions` or use-intl's `DateTimeFormatOptions` to avoid the
 * `exactOptionalPropertyTypes` narrowness conflict noted in earlier versions.
 */

/**
 * Union of the six named dateTime preset keys understood by `buildFormats()`.
 *
 * Exported so that `GraceFormatter` (format-grace-timestamp.ts) and the
 * `src/i18n/next-intl.d.ts` AppConfig augmentation can reference the canonical
 * set without duplicating string literals.  Adding or removing a key here is a
 * compile error at every call site that uses the preset-name overload.
 */
export type DateTimePresetKey =
  | 'dateMedium'
  | 'dateMedium2Digit'
  | 'dateLong'
  | 'dateTimeMedium'
  | 'medium'
  | 'mediumWithTime';

export function buildFormats(locale: Locale) {
  if (locale === 'th') {
    return {
      dateTime: {
        dateMedium:       { year: 'numeric' as const, month: 'short' as const,  day: 'numeric' as const,  calendar: 'buddhist' as const },
        dateMedium2Digit: { year: 'numeric' as const, month: 'short' as const,  day: '2-digit' as const, calendar: 'buddhist' as const },
        dateLong:         { year: 'numeric' as const, month: 'long' as const,   day: 'numeric' as const,  calendar: 'buddhist' as const },
        dateTimeMedium:   { year: 'numeric' as const, month: 'short' as const,  day: 'numeric' as const,  hour: '2-digit' as const, minute: '2-digit' as const, calendar: 'buddhist' as const },
        medium:           { dateStyle: 'medium' as const, calendar: 'buddhist' as const },
        mediumWithTime:   { dateStyle: 'medium' as const, timeStyle: 'short' as const,  calendar: 'buddhist' as const },
      } satisfies Record<DateTimePresetKey, object>,
    };
  }
  return {
    dateTime: {
      dateMedium:       { year: 'numeric' as const, month: 'short' as const,  day: 'numeric' as const },
      dateMedium2Digit: { year: 'numeric' as const, month: 'short' as const,  day: '2-digit' as const },
      dateLong:         { year: 'numeric' as const, month: 'long' as const,   day: 'numeric' as const },
      dateTimeMedium:   { year: 'numeric' as const, month: 'short' as const,  day: 'numeric' as const,  hour: '2-digit' as const, minute: '2-digit' as const },
      medium:           { dateStyle: 'medium' as const },
      mediumWithTime:   { dateStyle: 'medium' as const, timeStyle: 'short' as const },
    } satisfies Record<DateTimePresetKey, object>,
  };
}
