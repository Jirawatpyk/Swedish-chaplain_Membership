import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, type Locale } from './config';

/**
 * Per-request locale resolution for next-intl.
 *
 * Priority:
 *  1. requestLocale from routing middleware (future: URL-prefix routing)
 *  2. NEXT_LOCALE cookie (E2E tests + future locale-switcher in <UserMenu>)
 *  3. defaultLocale ('en')
 */

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
 * Return type is intentionally inferred (not annotated) so it satisfies
 * `IntlConfig['formats']` from use-intl exactly — a manual `Record<string,
 * Intl.DateTimeFormatOptions>` annotation conflicts with use-intl's own
 * `DateTimeFormatOptions` under `exactOptionalPropertyTypes`.
 */
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
      },
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
    },
  };
}

export default getRequestConfig(async ({ requestLocale }) => {
  const fromRouting = await requestLocale;

  const cookieStore = await cookies();
  const fromCookie = cookieStore.get('NEXT_LOCALE')?.value;

  const raw = fromRouting ?? fromCookie;
  const locale: Locale = raw && isLocale(raw) ? raw : defaultLocale;

  const messages = (await import(`./messages/${locale}.json`)).default;

  return {
    locale,
    messages,
    timeZone: 'Asia/Bangkok',
    now: new Date(),
    formats: buildFormats(locale),
  };
});
