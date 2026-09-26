/**
 * Segment layout for `/unsubscribe/[token]`. Renders no markup of its own:
 * it only passes the monitored privacy inbox and the recipient's locale to
 * the client error boundary (`error.tsx`), so even the last-resort error
 * state names a free, usable way to object (GDPR Art. 12(2), Art. 21).
 *
 * Must never throw — an error here is NOT caught by this segment's
 * `error.tsx`. The locale is the token's unsigned `lang` claim (same pure
 * parse as `generateMetadata`); anything unusable falls back to `en`.
 */
import { env } from '@/lib/env';
import { isLocale } from '@/i18n/config';
import { peekTokenLang } from '@/modules/broadcasts';
import {
  UnsubscribeContactProvider,
  type UnsubscribeLocale,
} from './unsubscribe-contact-context';

export default async function UnsubscribeTokenLayout({
  children,
  params,
}: {
  readonly children: React.ReactNode;
  readonly params: Promise<{ readonly token: string }>;
}): Promise<React.ReactElement> {
  let locale: UnsubscribeLocale = 'en';
  try {
    const lang = peekTokenLang((await params).token);
    if (lang && isLocale(lang)) locale = lang;
  } catch {
    // keep 'en'
  }
  return (
    <UnsubscribeContactProvider email={env.broadcasts.privacyContactEmail ?? null} locale={locale}>
      {children}
    </UnsubscribeContactProvider>
  );
}
