/**
 * Where a TEST COPY's Unsubscribe link lands (R105, PR #692).
 *
 * A real E-Blast's footer carries Resend Broadcasts' per-recipient merge
 * tag, which only Broadcasts substitutes; a test copy goes out through the
 * transactional sender, so `sendTestCopy` points the link here instead. The
 * page says it is a test and what the real link does. It reads nothing,
 * writes nothing and takes no token, so it has no form and no button
 * (the maintainer, 29 Oct 2026).
 *
 * The static segment takes precedence over `/unsubscribe/[token]`. `lang`
 * is the copy's own locale (`?lang=`), anything else falls back to EN.
 */
import type { Metadata } from 'next';
import { createTranslator } from 'next-intl';
import { Card } from '@jirawatpyk/aura-react/server';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import { env } from '@/lib/env';
import { resolveTenantDisplayName } from '@/lib/broadcasts-route-helpers';

type Locale = 'en' | 'th' | 'sv';
const MESSAGES = { en: enMessages, th: thMessages, sv: svMessages } as const;

interface PageProps {
  readonly searchParams: Promise<{ readonly lang?: string | string[] }>;
}

async function localeOf(searchParams: PageProps['searchParams']): Promise<Locale> {
  const raw = (await searchParams).lang;
  const lang = Array.isArray(raw) ? raw[0] : raw;
  return lang === 'th' || lang === 'sv' ? lang : 'en';
}

function translator(locale: Locale) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: 'public.unsubscribe' });
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const t = translator(await localeOf(searchParams));
  return { title: t('testCopy.metaTitle'), robots: { index: false, follow: false, noarchive: true } };
}

export default async function TestCopyUnsubscribePage({ searchParams }: PageProps): Promise<React.ReactElement> {
  const locale = await localeOf(searchParams);
  const t = translator(locale);
  let tenantDisplayName: string;
  try {
    tenantDisplayName = await resolveTenantDisplayName(env.tenant.slug);
  } catch {
    tenantDisplayName = t('fallbackChamberName');
  }
  return (
    <main lang={locale} className="mx-auto flex min-h-screen max-w-md flex-col justify-center p-6">
      <Card>
        <div className="flex flex-col gap-[var(--aura-space-3)]">
          <h1 className="aura-text-h3">{t('testCopy.heading')}</h1>
          <p>{t('testCopy.body', { tenantDisplayName })}</p>
          <p className="text-[var(--aura-fg-secondary)]">{t('testCopy.nothingChanged')}</p>
        </div>
      </Card>
    </main>
  );
}
