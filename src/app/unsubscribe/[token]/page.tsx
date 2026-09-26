/**
 * T144 / T145 / T146 — Public unsubscribe page (F7 US4 / FR-029–FR-032).
 *
 * Server-rendered Node.js route. NO authentication. NO CSRF (action is
 * recipient-side, idempotent, signed-token-protected). NO client JS
 * required to complete the unsubscribe — the entire flow happens
 * server-side at request time and renders the result inline.
 *
 * The verify → `unsubscribeRecipient` pipeline lives in
 * `@/lib/broadcasts-public-unsubscribe` (`processUnsubscribe`), shared
 * with the RFC 8058 one-click POST handler (`/api/unsubscribe/[token]`,
 * reached via the proxy rewrite of `POST /unsubscribe/[token]`). This page
 * is the `page_get` channel.
 *
 * States: success · already · invalid · error (with a "Try again" link to
 * this same URL) · rate_limited (says nothing about the token). Every
 * state names the monitored privacy inbox (`TENANT_PRIVACY_CONTACT_EMAIL`,
 * bare address) as the free manual-removal route (GDPR Art. 12(2)-(3),
 * Art. 21; PDPA §32) and links the tenant privacy notice when configured.
 *
 * NOTE: this page is OUTSIDE any (group) so it inherits ONLY
 * `src/app/layout.tsx` which sets `NextIntlClientProvider` from the
 * cookie / middleware. We override translations explicitly via
 * `getTranslations({ locale })` so the page text honours the
 * recipient's resolved locale even when no cookie is present.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { randomUUID } from 'node:crypto';
import { getTranslations } from 'next-intl/server';
import { AlertCircle, CheckCircle2, Clock, Info, XCircle } from 'lucide-react';

import { peekTokenLang } from '@/modules/broadcasts';
import { resolveTenantDisplayName } from '@/lib/broadcasts-route-helpers';
import {
  processUnsubscribe,
  type UnsubscribeOutcome,
} from '@/lib/broadcasts-public-unsubscribe';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { broadcastsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

// Test seam kept at its historical import path (T138 integration test).
export { processUnsubscribe, type UnsubscribeOutcome };

// Force dynamic rendering — token verification must happen per request.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PageProps {
  readonly params: Promise<{ readonly token: string }>;
  readonly searchParams: Promise<{ readonly lang?: string | string[] }>;
}

/**
 * `noindex,nofollow` is non-negotiable: the URL embeds a signed token that
 * is per-recipient PII proxy. A search-engine crawl would leak the token
 * into archive caches.
 *
 * Locale-aware title (Phase 9 i18n cleanup): `peekTokenLang` decodes the
 * unsigned `lang` claim ONLY (no HMAC verify, no DB roundtrip — pure
 * in-memory parse). A forged `lang` only changes the rendered `<title>`
 * of the attacker's own request — same surface area as the existing
 * `peekTokenTenantId` pattern. Falls back to `en` when missing/malformed
 * so the title always renders even on a corrupt token.
 */
export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const lang = peekTokenLang(token) ?? 'en';
  const t = await getTranslations({ locale: lang, namespace: 'public.unsubscribe' });
  return {
    title: t('metaTitle'),
    robots: { index: false, follow: false, noarchive: true },
  };
}

function pickFirst(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function UnsubscribePage({
  params,
  searchParams,
}: PageProps): Promise<React.ReactElement> {
  const { token } = await params;
  const sp = await searchParams;
  const queryLang = pickFirst(sp.lang);

  const h = await headers();
  const acceptLanguage = h.get('accept-language');
  const sourceIp =
    h.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    h.get('x-real-ip') ??
    '0.0.0.0';
  const requestId = h.get('x-request-id') ?? randomUUID();

  // T174 — root span `public_unsubscribe` per docs § 22 trace tree.
  // Token verify + DB upsert sub-spans hang from this root via
  // auto-instrumentation.
  const span = broadcastsTracer().startSpan('public_unsubscribe', {
    attributes: { 'request.id': requestId },
  });
  let outcome: Awaited<ReturnType<typeof processUnsubscribe>>['outcome'];
  let locale: Awaited<ReturnType<typeof processUnsubscribe>>['locale'];
  try {
    const result = await processUnsubscribe(
      token,
      queryLang,
      acceptLanguage,
      sourceIp,
      requestId,
    );
    outcome = result.outcome;
    locale = result.locale;
    span.setAttribute('broadcasts.outcome', outcome.state);
  } catch (e) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: e instanceof Error ? e.message : 'unsubscribe_threw',
    });
    span.end();
    throw e;
  }
  span.end();

  const t = await getTranslations({
    locale,
    namespace: 'public.unsubscribe',
  });

  // The manual-removal contact on every state: the monitored privacy inbox,
  // always a bare address — never the (possibly unmonitored, display-name)
  // sending address `BROADCASTS_FROM_EMAIL`.
  const supportEmail = env.broadcasts.privacyContactEmail;

  // Tenant name for the contact + privacy lines. States that verified a
  // token carry it; the others (invalid, rate_limited, error) use this
  // deployment's tenant — known from config, never from the token, so it
  // reveals nothing about the link.
  let tenantDisplayName: string;
  if ('tenantDisplayName' in outcome) {
    tenantDisplayName = outcome.tenantDisplayName;
  } else {
    try {
      tenantDisplayName = await resolveTenantDisplayName(env.tenant.slug);
    } catch (e) {
      logger.warn(
        { err: (e as Error).message, requestId },
        'unsubscribe_page_tenant_name_failed',
      );
      tenantDisplayName = t('fallbackChamberName');
    }
  }
  const privacyPolicyUrl = env.broadcasts.privacyPolicyUrl;
  const websiteUrl = env.broadcasts.websiteUrl;
  const retryHref = `/unsubscribe/${encodeURIComponent(token)}?lang=${locale}`;

  // Render `<email></email>` rich placeholder in i18n contact strings
  // as a real `<a href="mailto:...">` so mobile recipients can tap to
  // open their composer (UX § 1.3 + WCAG 2.2 SC 2.5.8 touch target).
  // The placeholder is self-closing in every locale — we always render
  // the address itself inside the anchor.
  const mailtoLink = (): React.ReactNode => (
    <a
      href={`mailto:${supportEmail}`}
      className="inline-block py-1 font-medium text-foreground underline underline-offset-4 hover:text-primary focus:text-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      {supportEmail}
    </a>
  );

  // Per-state visual cue so recipients can tell success / already /
  // invalid / error apart in a glance — important on mobile where the
  // heading text + colour may be the only differentiation.
  const STATE_ICON: Record<
    UnsubscribeOutcome['state'],
    { readonly Icon: typeof CheckCircle2; readonly className: string }
  > = {
    success: {
      Icon: CheckCircle2,
      className: 'text-green-600 dark:text-green-400',
    },
    already: { Icon: Info, className: 'text-muted-foreground' },
    error: {
      Icon: AlertCircle,
      className: 'text-yellow-600 dark:text-yellow-400',
    },
    invalid: { Icon: XCircle, className: 'text-muted-foreground' },
    rate_limited: { Icon: Clock, className: 'text-muted-foreground' },
  };
  const { Icon: StateIcon, className: stateIconColor } =
    STATE_ICON[outcome.state];

  // Container deviation note: `max-w-md` (28rem) is narrower than the
  // ux-standards § 18 `FormContainer` (42rem) because this is a
  // status-only confirmation page (no form fields, no shell, decoupled
  // from authenticated portals). The narrow card matches recipient
  // expectations from List-Unsubscribe one-click flows in mainstream
  // mail clients.
  return (
    <main
      lang={locale}
      className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6 text-center"
    >
      <article className="w-full rounded-lg border border-border bg-card p-8 shadow-sm">
        <StateIcon
          className={`mx-auto mb-4 h-12 w-12 ${stateIconColor}`}
          aria-hidden="true"
        />
        {outcome.state === 'success' ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('success.heading')}
            </h1>
            <p className="mb-3 text-base text-foreground">
              {t('success.body', {
                tenantDisplayName: outcome.tenantDisplayName,
              })}
            </p>
            <p className="mb-3 text-base text-foreground">
              {t('success.transactional')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t.rich('success.contact', { email: mailtoLink })}
            </p>
          </>
        ) : outcome.state === 'already' ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('already.heading')}
            </h1>
            <p className="mb-3 text-base text-foreground">
              {t('already.body', {
                tenantDisplayName: outcome.tenantDisplayName,
              })}
            </p>
            <p className="text-sm text-muted-foreground">
              {t.rich('already.contact', { email: mailtoLink })}
            </p>
          </>
        ) : outcome.state === 'error' ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('error.heading')}
            </h1>
            <p className="mb-3 text-base text-foreground">
              {t('error.body')}
            </p>
            <p className="mb-3">
              <a
                href={retryHref}
                className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {t('error.tryAgain')}
              </a>
            </p>
            <p className="text-sm text-muted-foreground">
              {t.rich('error.contact', { email: mailtoLink, tenantDisplayName })}
            </p>
          </>
        ) : outcome.state === 'rate_limited' ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('rateLimited.heading')}
            </h1>
            <p className="mb-3 text-base text-foreground">
              {t('rateLimited.body')}
            </p>
          </>
        ) : (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('invalid.heading')}
            </h1>
            <p className="mb-3 text-base text-foreground">
              {t('invalid.body')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t.rich('invalid.contact', { email: mailtoLink, tenantDisplayName })}
            </p>
          </>
        )}
        {/* Privacy notice (GDPR Art. 13/14 transparency) — every state,
            when the tenant has published one. */}
        {privacyPolicyUrl ? (
          <p className="mt-6 text-sm text-muted-foreground">
            {t.rich('privacyLine', {
              tenantDisplayName,
              link: (chunks) => (
                <a
                  href={privacyPolicyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={EXTERNAL_LINK_CLASS}
                >
                  {chunks}
                  <span className="sr-only"> {t('opensInNewTab')}</span>
                </a>
              ),
            })}
          </p>
        ) : null}
        {/* UX-6 — link back to chamber website (when configured).
            Omitted entirely when env var unset so no dead anchor. */}
        {websiteUrl ? (
          <p className={privacyPolicyUrl ? 'mt-2 text-sm' : 'mt-6 text-sm'}>
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={EXTERNAL_LINK_CLASS}
            >
              {t('chamberWebsiteLink')}
              <span className="sr-only"> {t('opensInNewTab')}</span>
            </a>
          </p>
        ) : null}
      </article>
    </main>
  );
}

const EXTERNAL_LINK_CLASS =
  'underline underline-offset-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 inline-block py-1';
