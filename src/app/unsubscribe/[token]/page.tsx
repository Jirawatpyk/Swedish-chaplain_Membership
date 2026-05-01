/**
 * T144 / T145 / T146 — Public unsubscribe page (F7 US4 / FR-029–FR-032).
 *
 * Server-rendered Node.js route. NO authentication. NO CSRF (action is
 * recipient-side, idempotent, signed-token-protected). NO client JS
 * required to complete the unsubscribe — the entire flow happens
 * server-side at request time and renders the result inline.
 *
 * Pipeline:
 *   1. Peek the token's tenant id (pre-tenant resolver — verifies nothing).
 *   2. Bind RLS context with `runInTenant(tenantCtx, ...)`.
 *   3. Verify HMAC under the bound tenant via `unsubscribeTokenSigner.verify`.
 *      Failure → emit `broadcast_unsubscribe_token_invalid` audit + render
 *      fallback page (T145).
 *   4. Call `unsubscribeRecipient` use-case (T142). Returns
 *      `{wasNew: true}` first time → success page; `{wasNew: false}` →
 *      idempotent "already unsubscribed" page (T146).
 *
 * Locale resolution per FR-039 + i18n.md CHK010:
 *   1. Token's signed `lang` claim
 *   2. `?lang=` query param (un-signed; only used as fallback)
 *   3. `Accept-Language` request header
 *   4. Tenant default ('th' for SweCham; static map for now)
 *   5. 'en' final fallback
 *
 * Pre-fetch protection: many corporate mail clients pre-fetch links to
 * scan for malware. The handler is idempotent so pre-fetch + actual
 * click produce the same outcome (one upsert, no duplicate audit).
 *
 * Rate-limit (per contracts/unsubscribe-public.md § 9): 20 hits / 5 min
 * per source IP — defends against token-brute-force enumeration.
 *
 * NOTE: this page is OUTSIDE any (group) so it inherits ONLY
 * `src/app/layout.tsx` which sets `NextIntlClientProvider` from the
 * cookie / middleware. We override translations explicitly via
 * `getTranslations({ locale })` so the page text honours the
 * recipient's resolved locale even when no cookie is present.
 */
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getTranslations } from 'next-intl/server';
import { AlertCircle, CheckCircle2, Info, XCircle } from 'lucide-react';

import { db } from '@/lib/db';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { isLocale, type Locale } from '@/i18n/config';
import { asTenantContext } from '@/modules/tenants';
import {
  asBroadcastId,
  broadcastsRateLimiter,
  makeUnsubscribeRecipientDeps,
  peekTokenTenantId,
  tenantDefaultLocaleFor,
  unsubscribeRecipient,
  unsubscribeTokenSigner,
} from '@/modules/broadcasts';
import { resolveTenantDisplayName } from '@/lib/broadcasts-route-helpers';
import { env } from '@/lib/env';
import { broadcastsMetrics } from '@/lib/metrics';

/**
 * E1 — anti-enumeration rate limit per plan.md § Storage L67:
 *   20 hits / 5 min per source IP.
 * Legitimate clicks rarely hit the limit; a token-brute-force scanner
 * does. Rate-limit window keyed by IP (not by token) so an attacker
 * cycling many forged tokens still bumps the same bucket.
 */
const UNSUBSCRIBE_RATE_LIMIT_MAX = 20;
const UNSUBSCRIBE_RATE_LIMIT_WINDOW_S = 300;

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
 * into archive caches. Title is intentionally generic — the per-state
 * heading lives in the page body, not the tab.
 */
export const metadata: Metadata = {
  title: 'Unsubscribe',
  robots: { index: false, follow: false, noarchive: true },
};

export type UnsubscribeOutcome =
  | {
      readonly state: 'success';
      readonly tenantDisplayName: string;
      readonly tenantSupportEmail: string;
    }
  | {
      readonly state: 'already';
      readonly tenantDisplayName: string;
      readonly tenantSupportEmail: string;
    }
  | { readonly state: 'invalid' }
  | {
      readonly state: 'error';
      readonly tenantSupportEmail: string;
    };

function pickFirst(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function parseAcceptLanguage(header: string | null): Locale | null {
  if (!header) return null;
  // Take the first language tag's primary subtag (`th-TH;q=0.9,en;q=0.8` → `th`).
  const first = header.split(',')[0]?.split(';')[0]?.trim().toLowerCase();
  if (!first) return null;
  const primary = first.split('-')[0];
  if (primary === 'th' || primary === 'sv' || primary === 'en') return primary;
  return null;
}

function resolveLocale(
  tokenLang: Locale | undefined,
  queryLang: string | null,
  acceptLanguage: string | null,
  tenantId: string | null,
): Locale {
  if (tokenLang && isLocale(tokenLang)) return tokenLang;
  if (queryLang && isLocale(queryLang)) return queryLang;
  const fromHeader = parseAcceptLanguage(acceptLanguage);
  if (fromHeader) return fromHeader;
  if (tenantId) return tenantDefaultLocaleFor(tenantId);
  return 'en';
}

async function emitInvalidTokenAudit(
  tenantId: string | null,
  failureReason: string,
  sourceIp: string,
  requestId: string,
): Promise<void> {
  // Best-effort: write the audit row through the system db handle (no
  // tenant context if we couldn't resolve one). NULL tenant is allowed
  // by the audit_log schema for cross-tenant signals like sig-rejects.
  try {
    await db.execute(sql`
      INSERT INTO audit_log
        (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
      VALUES
        ('broadcast_unsubscribe_token_invalid'::audit_event_type,
         'system:public_unsubscribe',
         ${`Public unsubscribe rejected: ${failureReason}`},
         ${requestId},
         ${JSON.stringify({ failureReason, sourceIp })}::jsonb,
         ${tenantId},
         5)
    `);
  } catch (e) {
    logger.error(
      { err: (e as Error).message, failureReason, requestId },
      'unsubscribe_invalid_audit_emit_failed',
    );
  }
}

/**
 * Test seam: `processUnsubscribe(...)` is exported for the T138
 * integration test which exercises the full token → DB write pipeline
 * without dragging in the Next.js request-scoped header reader.
 * Production callers go through the page component below which awaits
 * the request headers and forwards them into this function.
 *
 * Contract: this function NEVER throws. Every code path either returns
 * a valid `{outcome, locale}` pair or is wrapped in a try/catch that
 * logs + emits an audit + falls back to `state: 'error'`. Throwing
 * would surface a Next.js 500 to the recipient on a GDPR Art. 21
 * surface — the worst possible outcome.
 */
export async function processUnsubscribe(
  tokenPlain: string,
  queryLang: string | null,
  acceptLanguage: string | null,
  sourceIp: string,
  requestId: string,
): Promise<{ readonly outcome: UnsubscribeOutcome; readonly locale: Locale }> {
  const startedAt = Date.now();
  const recordTtfb = (tenantIdLabel: string | null): void => {
    broadcastsMetrics.unsubscribePageTtfbMs(
      tenantIdLabel,
      Date.now() - startedAt,
    );
  };

  // Centralise the "render fallback page + emit audit + counter +
  // record TTFB" exit path so the 4–5 reject branches below stay
  // consistent (any divergence here is a Principle I append-only
  // signal-loss bug). `outcome` defaults to `'invalid'` because
  // every reject branch except the unhandled-throw uses that state.
  const reject = async (
    reason: string,
    tenantIdLabel: string | null,
    tokenLang: Locale | undefined,
    outcomeLabel: 'invalid' | 'rate_limited' = 'invalid',
  ): Promise<{ readonly outcome: UnsubscribeOutcome; readonly locale: Locale }> => {
    await emitInvalidTokenAudit(tenantIdLabel, reason, sourceIp, requestId);
    broadcastsMetrics.unsubscribesCount(tenantIdLabel, outcomeLabel);
    recordTtfb(tenantIdLabel);
    return {
      outcome: { state: 'invalid' },
      locale: resolveLocale(tokenLang, queryLang, acceptLanguage, tenantIdLabel),
    };
  };

  // E1 — anti-enumeration rate limit (20 hits / 5 min per source IP).
  // Best-effort: a Redis outage MUST NOT take the unsubscribe page
  // offline (GDPR Art. 21 right-to-object overrides operational
  // signal loss). On limiter error we log and proceed with the request.
  try {
    const rl = await broadcastsRateLimiter.checkLimit(
      `unsubscribe:${sourceIp}`,
      UNSUBSCRIBE_RATE_LIMIT_MAX,
      UNSUBSCRIBE_RATE_LIMIT_WINDOW_S,
    );
    if (!rl.ok) return reject('rate_limited', null, undefined, 'rate_limited');
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, requestId },
      'unsubscribe_rate_limit_check_failed',
    );
  }

  const tenantId = peekTokenTenantId(tokenPlain);
  if (tenantId === null) return reject('malformed_token', null, undefined);

  // Verify under the resolved tenant (HMAC secret is process-wide so
  // verification is tenant-agnostic, but we bind RLS context first so
  // the use-case's repo calls hit the right tenant slice).
  const verifyResult = unsubscribeTokenSigner.verify(tokenPlain);
  if (!verifyResult.ok) {
    return reject(verifyResult.error.kind, tenantId, undefined);
  }
  const payload = verifyResult.value;

  // Defence-in-depth: peek and verify both parse `tid` from the same
  // base64url-encoded payload, so they CANNOT diverge unless one of the
  // parsers contains a bug. The check is intentionally cheap and stays
  // here as a guard against future refactors that might separate the
  // two parsers (e.g. if peek ever moves to reading a different field).
  if (payload.tenantId !== tenantId) {
    return reject('tenant_id_mismatch', tenantId, payload.lang);
  }

  let tenantCtx;
  try {
    tenantCtx = asTenantContext(payload.tenantId);
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, tenantId: payload.tenantId },
      'unsubscribe_invalid_tenant_slug',
    );
    return reject('invalid_tenant_slug', payload.tenantId, payload.lang);
  }

  const tenantSupportEmail = env.broadcasts.fromEmail;
  const locale = resolveLocale(
    payload.lang,
    queryLang,
    acceptLanguage,
    payload.tenantId,
  );

  // Top-level guard: every step from here on touches infrastructure
  // (tenant settings, RLS bind, DB upsert) and may throw on transient
  // outages. The `/unsubscribe/[token]` page contract is "always
  // render, never throw" (GDPR Art. 21 surface) — collapse any throw
  // into the retry-state error page below.
  // Fallback uses the localised "the chamber" string rather than echoing
  // the raw tenant slug — slugs read as internal identifiers ("swecham")
  // and feel unprofessional on a GDPR Art. 21 surface where the recipient
  // already trusts the link came from a real organisation.
  let tenantDisplayName: string;
  try {
    tenantDisplayName = await resolveTenantDisplayName(payload.tenantId);
  } catch (e) {
    logger.error(
      { err: (e as Error).message, tenantId: payload.tenantId, requestId },
      'unsubscribe_tenant_displayname_lookup_failed',
    );
    const tFallback = await getTranslations({
      locale,
      namespace: 'public.unsubscribe',
    });
    tenantDisplayName = tFallback('fallbackChamberName');
  }

  const deps = makeUnsubscribeRecipientDeps(
    payload.tenantId,
    tenantDisplayName,
    tenantSupportEmail,
  );

  let result;
  try {
    result = await runInTenant(tenantCtx, async () =>
      unsubscribeRecipient(deps, {
        tenantId: payload.tenantId,
        broadcastId: asBroadcastId(payload.broadcastId),
        emailLower: payload.emailLower,
        tokenPlaintext: tokenPlain,
        requestId,
        reasonText: null,
      }),
    );
  } catch (e) {
    logger.error(
      { err: (e as Error).message, tenantId: payload.tenantId, requestId },
      'unsubscribe_unhandled_error',
    );
    broadcastsMetrics.unsubscribesCount(payload.tenantId, 'unhandled_error');
    recordTtfb(payload.tenantId);
    return {
      outcome: { state: 'error', tenantSupportEmail },
      locale,
    };
  }

  if (!result.ok) {
    // Distinguish transient infrastructure failure (`repo_error`) from
    // a token / business-rule rejection. The recipient sees a distinct
    // "please try again" state with support contact, not the misleading
    // "link invalid or expired" — their unsubscribe was NOT recorded.
    if (result.error.kind === 'unsubscribe.repo_error') {
      logger.error(
        { kind: result.error.kind, requestId },
        'unsubscribe_repo_error',
      );
      broadcastsMetrics.unsubscribesCount(payload.tenantId, 'repo_error');
      recordTtfb(payload.tenantId);
      return {
        outcome: { state: 'error', tenantSupportEmail },
        locale,
      };
    }
    logger.error(
      { kind: result.error.kind, requestId },
      'unsubscribe_use_case_error',
    );
    broadcastsMetrics.unsubscribesCount(payload.tenantId, 'invalid');
    recordTtfb(payload.tenantId);
    return { outcome: { state: 'invalid' }, locale };
  }

  broadcastsMetrics.unsubscribesCount(
    payload.tenantId,
    result.value.wasNew ? 'success' : 'already',
  );
  recordTtfb(payload.tenantId);

  return {
    outcome: {
      state: result.value.wasNew ? 'success' : 'already',
      tenantDisplayName: result.value.tenantDisplayName,
      tenantSupportEmail: result.value.tenantSupportEmail,
    },
    locale,
  };
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

  const { outcome, locale } = await processUnsubscribe(
    token,
    queryLang,
    acceptLanguage,
    sourceIp,
    requestId,
  );

  const t = await getTranslations({
    locale,
    namespace: 'public.unsubscribe',
  });

  // The support email rendered in the contact line. For the `invalid`
  // state we don't have a verified tenant — fall back to the platform
  // broadcasts inbox.
  const supportEmail =
    outcome.state === 'invalid'
      ? env.broadcasts.fromEmail
      : outcome.tenantSupportEmail;

  // Render `<email></email>` rich placeholder in i18n contact strings
  // as a real `<a href="mailto:...">` so mobile recipients can tap to
  // open their composer (UX § 1.3 + WCAG 2.2 SC 2.5.8 touch target).
  // The placeholder is self-closing in every locale — we always render
  // the address itself inside the anchor.
  const mailtoLink = (): React.ReactNode => (
    <a
      href={`mailto:${supportEmail}`}
      className="font-medium text-foreground underline underline-offset-4 hover:text-primary focus:text-primary focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
    >
      {supportEmail}
    </a>
  );

  // Per-state visual cue so recipients can tell success / already /
  // invalid / error apart in a glance — important on mobile where the
  // heading text + colour may be the only differentiation.
  const stateIcon =
    outcome.state === 'success' ? (
      <CheckCircle2
        className="mx-auto mb-4 h-12 w-12 text-green-600 dark:text-green-400"
        aria-hidden="true"
      />
    ) : outcome.state === 'already' ? (
      <Info
        className="mx-auto mb-4 h-12 w-12 text-muted-foreground"
        aria-hidden="true"
      />
    ) : outcome.state === 'error' ? (
      <AlertCircle
        className="mx-auto mb-4 h-12 w-12 text-yellow-600 dark:text-yellow-400"
        aria-hidden="true"
      />
    ) : (
      <XCircle
        className="mx-auto mb-4 h-12 w-12 text-muted-foreground"
        aria-hidden="true"
      />
    );

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
        {stateIcon}
        {outcome.state === 'success' ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('success.heading')}
            </h1>
            <p className="mb-3 text-base text-muted-foreground">
              {t('success.body', {
                tenantDisplayName: outcome.tenantDisplayName,
              })}
            </p>
            <p className="mb-3 text-base text-muted-foreground">
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
            <p className="mb-3 text-base text-muted-foreground">
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
            <p className="mb-3 text-base text-muted-foreground">
              {t('error.body')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t.rich('error.contact', { email: mailtoLink })}
            </p>
          </>
        ) : (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('invalid.heading')}
            </h1>
            <p className="mb-3 text-base text-muted-foreground">
              {t('invalid.body')}
            </p>
            <p className="text-sm text-muted-foreground">
              {t.rich('invalid.contact', { email: mailtoLink })}
            </p>
          </>
        )}
      </article>
    </main>
  );
}
