import { getRequestConfig } from 'next-intl/server';
import { defaultLocale, isLocale, type Locale } from './config';

/**
 * Per-request locale resolution for next-intl.
 *
 * F1 does not yet expose locale switching in the UI (planned for Polish phase
 * via <UserMenu>). For now the locale defaults to `en` and falls back there
 * if the requested header is unknown.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale: Locale = requested && isLocale(requested) ? requested : defaultLocale;

  const messages = (await import(`./messages/${locale}.json`)).default;

  return {
    locale,
    messages,
    timeZone: 'Asia/Bangkok',
    now: new Date(),
  };
});
