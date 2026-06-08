import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, type Locale } from './config';
import { buildFormats } from './formats';

export { buildFormats };

/**
 * Per-request locale resolution for next-intl.
 *
 * Priority:
 *  1. requestLocale from routing middleware (future: URL-prefix routing)
 *  2. NEXT_LOCALE cookie (E2E tests + future locale-switcher in <UserMenu>)
 *  3. defaultLocale ('en')
 *
 * dateTime format presets live in `./formats` (pure module, no Next.js
 * runtime imports) so the check:intl-formats script can import them
 * without instantiating the Next.js request context.
 */

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
