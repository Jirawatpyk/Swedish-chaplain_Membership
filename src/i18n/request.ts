import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, LOCALE_COOKIE_NAME, type Locale } from './config';
import { buildFormats } from './formats';

export { buildFormats };

/**
 * Per-request locale resolution for next-intl.
 *
 * Priority:
 *  1. requestLocale from routing middleware (future: URL-prefix routing)
 *  2. NEXT_LOCALE cookie (set by the header <LocaleSwitcher /> and E2E tests)
 *  3. defaultLocale ('en')
 *
 * dateTime format presets live in `./formats` (pure module, no Next.js
 * runtime imports). The `src/i18n/next-intl.d.ts` AppConfig augmentation
 * imports `buildFormats` at the type level for compile-time preset checking.
 */

export default getRequestConfig(async ({ requestLocale }) => {
  const fromRouting = await requestLocale;

  const cookieStore = await cookies();
  const fromCookie = cookieStore.get(LOCALE_COOKIE_NAME)?.value;

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
