/**
 * Where a TEST COPY's Unsubscribe link lands (R105, PR #692).
 *
 * A real E-Blast's footer carries Resend Broadcasts' per-recipient merge
 * tag, which only Broadcasts substitutes; a test copy goes out through the
 * transactional sender, so `sendTestCopy` points the link here instead. The
 * page says it was a test and what the real link does, and names the real
 * ways to opt out: the Unsubscribe link in any E-Blast, or the monitored
 * privacy inbox (GDPR Art. 12(2), Art. 21; PDPA §32). It writes nothing and
 * takes no token, so it has no form and no button (the maintainer,
 * 29 Oct 2026). It reads only the tenant's display name.
 *
 * The static segment takes precedence over `/unsubscribe/[token]`, and the
 * proxy never rewrites its POST. `lang` is the copy's own locale (`?lang=`),
 * anything else falls back to EN.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { isLocale, type Locale } from '@/i18n/config';
import { env } from '@/lib/env';
import { resolveTenantDisplayName } from '@/lib/broadcasts-route-helpers';

interface PageProps {
  readonly searchParams: Promise<{ readonly lang?: string | string[] }>;
}

async function localeOf(searchParams: PageProps['searchParams']): Promise<Locale> {
  const raw = (await searchParams).lang;
  const lang = Array.isArray(raw) ? raw[0] : raw;
  return lang !== undefined && isLocale(lang) ? lang : 'en';
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const t = await getTranslations({ locale: await localeOf(searchParams), namespace: 'public.unsubscribe' });
  return { title: t('testCopy.metaTitle'), robots: { index: false, follow: false, noarchive: true } };
}

export default async function TestCopyUnsubscribePage({ searchParams }: PageProps): Promise<React.ReactElement> {
  const locale = await localeOf(searchParams);
  const t = await getTranslations({ locale, namespace: 'public.unsubscribe' });
  // Never throws: falls back to the tenant slug on a failed lookup.
  const tenantDisplayName = await resolveTenantDisplayName(env.tenant.slug);
  const { privacyContactEmail, privacyPolicyUrl } = env.broadcasts;
  return (
    <main lang={locale} className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <Card>
        <div className="flex flex-col gap-[var(--aura-space-3)]">
          <h1 className="aura-text-h3">{t('testCopy.heading')}</h1>
          <p>{t('testCopy.body', { tenantDisplayName })}</p>
          <p className="text-[var(--aura-fg-secondary)]">{t('testCopy.nothingChanged')}</p>
          <p>
            {t.rich('testCopy.optOut', {
              email: () => (
                <a href={`mailto:${privacyContactEmail}`} className="inline-block py-1 font-medium underline underline-offset-4">
                  {privacyContactEmail}
                </a>
              ),
            })}
          </p>
          {privacyPolicyUrl ? (
            <p className="text-[var(--aura-fg-secondary)]">
              {t.rich('privacyLine', {
                tenantDisplayName,
                link: (chunks) => (
                  <a href={privacyPolicyUrl} target="_blank" rel="noopener noreferrer" className="inline-block py-1 underline underline-offset-2">
                    {chunks}
                    <span className="sr-only"> {t('opensInNewTab')}</span>
                  </a>
                ),
              })}
            </p>
          ) : null}
        </div>
      </Card>
    </main>
  );
}
