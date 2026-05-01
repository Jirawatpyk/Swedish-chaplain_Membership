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
import { headers } from 'next/headers';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getTranslations } from 'next-intl/server';

import { db } from '@/lib/db';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { isLocale, type Locale } from '@/i18n/config';
import { asTenantContext } from '@/modules/tenants';
import {
  makeUnsubscribeRecipientDeps,
  peekTokenTenantId,
  unsubscribeRecipient,
  unsubscribeTokenSigner,
  asBroadcastId,
} from '@/modules/broadcasts';
import { resolveTenantDisplayName } from '@/lib/broadcasts-route-helpers';
import { env } from '@/lib/env';
import { broadcastsMetrics } from '@/lib/metrics';
import { broadcastsRateLimiter } from '@/modules/broadcasts';

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
 * Test seam: `processUnsubscribe(...)` is exported for the T138
 * integration test which exercises the full token → DB write pipeline
 * without dragging in Next.js's request-scoped `headers()` helper.
 * Production callers go through the page component below which
 * forwards `headers()` values into this function.
 */
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
  | { readonly state: 'invalid' };

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

function tenantDefaultLocale(tenantId: string): Locale {
  // Static per-tenant default; in F12 white-label this moves to
  // tenant settings. SweCham defaults to TH per chamber preference.
  if (tenantId === 'swecham') return 'th';
  if (tenantId === 'jcc') return 'en';
  return 'en';
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
  if (tenantId) return tenantDefaultLocale(tenantId);
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
    if (!rl.ok) {
      await emitInvalidTokenAudit(null, 'rate_limited', sourceIp, requestId);
      broadcastsMetrics.unsubscribesCount(null, 'rate_limited');
      recordTtfb(null);
      return {
        outcome: { state: 'invalid' },
        locale: resolveLocale(undefined, queryLang, acceptLanguage, null),
      };
    }
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, requestId },
      'unsubscribe_rate_limit_check_failed',
    );
  }

  const tenantId = peekTokenTenantId(tokenPlain);
  if (tenantId === null) {
    await emitInvalidTokenAudit(null, 'malformed_token', sourceIp, requestId);
    broadcastsMetrics.unsubscribesCount(null, 'invalid');
    recordTtfb(null);
    return {
      outcome: { state: 'invalid' },
      locale: resolveLocale(undefined, queryLang, acceptLanguage, null),
    };
  }

  // Verify under the resolved tenant (HMAC secret is process-wide so
  // verification is tenant-agnostic, but we bind RLS context first so
  // the use-case's repo calls hit the right tenant slice).
  const verifyResult = unsubscribeTokenSigner.verify(tokenPlain);
  if (!verifyResult.ok) {
    await emitInvalidTokenAudit(
      tenantId,
      verifyResult.error.kind,
      sourceIp,
      requestId,
    );
    broadcastsMetrics.unsubscribesCount(tenantId, 'invalid');
    recordTtfb(tenantId);
    return {
      outcome: { state: 'invalid' },
      locale: resolveLocale(undefined, queryLang, acceptLanguage, tenantId),
    };
  }
  const payload = verifyResult.value;

  // The token's tid MUST match the peeked tid (defence in depth — a
  // mismatch indicates a tampered payload that survived HMAC because
  // the attacker controlled the signing). Belt-and-braces: should
  // never trip in practice.
  if (payload.tenantId !== tenantId) {
    await emitInvalidTokenAudit(
      tenantId,
      'tenant_id_mismatch',
      sourceIp,
      requestId,
    );
    broadcastsMetrics.unsubscribesCount(tenantId, 'invalid');
    recordTtfb(tenantId);
    return {
      outcome: { state: 'invalid' },
      locale: resolveLocale(payload.lang, queryLang, acceptLanguage, tenantId),
    };
  }

  let tenantCtx;
  try {
    tenantCtx = asTenantContext(payload.tenantId);
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, tenantId: payload.tenantId },
      'unsubscribe_invalid_tenant_slug',
    );
    await emitInvalidTokenAudit(
      payload.tenantId,
      'invalid_tenant_slug',
      sourceIp,
      requestId,
    );
    broadcastsMetrics.unsubscribesCount(payload.tenantId, 'invalid');
    recordTtfb(payload.tenantId);
    return {
      outcome: { state: 'invalid' },
      locale: resolveLocale(
        payload.lang,
        queryLang,
        acceptLanguage,
        payload.tenantId,
      ),
    };
  }

  const tenantDisplayName = await resolveTenantDisplayName(payload.tenantId);
  const tenantSupportEmail = env.broadcasts.fromEmail;
  const locale = resolveLocale(
    payload.lang,
    queryLang,
    acceptLanguage,
    payload.tenantId,
  );

  const deps = makeUnsubscribeRecipientDeps(
    payload.tenantId,
    tenantDisplayName,
    tenantSupportEmail,
  );

  const result = await runInTenant(tenantCtx, async () =>
    unsubscribeRecipient(deps, {
      tenantId: payload.tenantId,
      broadcastId: asBroadcastId(payload.broadcastId),
      emailLower: payload.emailLower,
      tokenPlaintext: tokenPlain,
      requestId,
      reasonText: null,
    }),
  );

  if (!result.ok) {
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
    outcome: result.value.wasNew
      ? {
          state: 'success',
          tenantDisplayName: result.value.tenantDisplayName,
          tenantSupportEmail: result.value.tenantSupportEmail,
        }
      : {
          state: 'already',
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

  return (
    <main
      lang={locale}
      className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center p-6 text-center"
    >
      <article className="w-full rounded-lg border border-border bg-card p-8 shadow-sm">
        {outcome.state === 'success' ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('success.heading')}
            </h1>
            <p className="mb-3 text-sm text-muted-foreground">
              {t('success.body', {
                tenantDisplayName: outcome.tenantDisplayName,
              })}
            </p>
            <p className="mb-3 text-sm text-muted-foreground">
              {t('success.transactional')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('success.contact', {
                supportEmail: outcome.tenantSupportEmail,
              })}
            </p>
          </>
        ) : outcome.state === 'already' ? (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('already.heading')}
            </h1>
            <p className="mb-3 text-sm text-muted-foreground">
              {t('already.body', {
                tenantDisplayName: outcome.tenantDisplayName,
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('already.contact', {
                supportEmail: outcome.tenantSupportEmail,
              })}
            </p>
          </>
        ) : (
          <>
            <h1 className="mb-4 text-2xl font-semibold">
              {t('invalid.heading')}
            </h1>
            <p className="mb-3 text-sm text-muted-foreground">
              {t('invalid.body')}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('invalid.contact', { supportEmail: env.broadcasts.fromEmail })}
            </p>
          </>
        )}
      </article>
    </main>
  );
}
