/**
 * Shared public-unsubscribe pipeline (F7 US4 / FR-029–FR-032).
 *
 * Two entry points run the SAME verify → `unsubscribeRecipient` pipeline:
 *   - `GET /unsubscribe/[token]` — the page a recipient opens
 *     (`src/app/unsubscribe/[token]/page.tsx`), channel `page_get`.
 *   - `POST /unsubscribe/[token]` — RFC 8058 one-click from a mail client,
 *     rewritten by `src/proxy.ts` to `src/app/api/unsubscribe/[token]/route.ts`,
 *     channel `one_click_post`.
 *
 * Pipeline:
 *   1. Rate limit (see `RATE LIMIT` below — differs per channel).
 *   2. Peek the token's tenant id (pre-tenant resolver — verifies nothing).
 *   3. Verify HMAC via `unsubscribeTokenSigner.verify`. Failure → emit
 *      `broadcast_unsubscribe_token_invalid` audit + `invalid` outcome.
 *   4. Bind RLS with `runInTenant(tenantCtx, ...)` and call
 *      `unsubscribeRecipient` — `{wasNew: true}` → `success`,
 *      `{wasNew: false}` → idempotent `already`.
 *
 * Locale resolution per FR-039 + i18n.md CHK010:
 *   1. Token's signed `lang` claim
 *   2. `?lang=` query param (un-signed; only used as fallback)
 *   3. `Accept-Language` request header
 *   4. Tenant default ('th' for SweCham; static map for now)
 *   5. 'en' final fallback
 *
 * Pre-fetch protection: many corporate mail clients pre-fetch links to
 * scan for malware. The pipeline is idempotent so pre-fetch + actual
 * click produce the same outcome (one upsert, no duplicate audit).
 *
 * RATE LIMIT (per contracts/unsubscribe-public.md § 9):
 *   - `page_get`: 20 hits / 5 min per source IP, checked BEFORE the token
 *     is parsed. Exceeded → `rate_limited` outcome, which reveals nothing
 *     about the token.
 *   - `one_click_post`: mail providers POST from a handful of shared IPs,
 *     so an up-front per-IP limit would drop genuine objections (GDPR
 *     Art. 21(3)). Only FAILED verifications are counted (20 / 5 min per
 *     IP); past the limit the failure is answered `rate_limited` and its
 *     audit row is skipped so a forged-token flood cannot fill the audit
 *     log. Valid tokens are HMAC-SHA256 under a ≥32-byte secret — not
 *     enumerable — so they always go through.
 *   Both fail open on a limiter outage (GDPR Art. 21 overrides signal loss).
 */
import { getTranslations } from 'next-intl/server';

import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { isLocale, type Locale } from '@/i18n/config';
import { asTenantContext } from '@/modules/tenants';
import {
  asBroadcastId,
  broadcastsRateLimiter,
  f7AuditAdapter,
  makeUnsubscribeRecipientDeps,
  peekTokenTenantId,
  tenantDefaultLocaleFor,
  unsubscribeRecipient,
  unsubscribeTokenSigner,
} from '@/modules/broadcasts';
import { resolveTenantDisplayName } from '@/lib/broadcasts-route-helpers';
import { env } from '@/lib/env';
import { broadcastsMetrics } from '@/lib/metrics';
import { sha256Hex } from '@/lib/crypto';

/**
 * E1 — anti-enumeration rate limit per plan.md § Storage L67:
 *   20 hits / 5 min per source IP.
 * Legitimate clicks rarely hit the limit; a token-brute-force scanner
 * does. Rate-limit window keyed by IP (not by token) so an attacker
 * cycling many forged tokens still bumps the same bucket.
 */
const UNSUBSCRIBE_RATE_LIMIT_MAX = 20;
const UNSUBSCRIBE_RATE_LIMIT_WINDOW_S = 300;

export type PublicUnsubscribeChannel = 'page_get' | 'one_click_post';

export type UnsubscribeOutcome =
  | { readonly state: 'success'; readonly tenantDisplayName: string }
  | { readonly state: 'already'; readonly tenantDisplayName: string }
  | { readonly state: 'invalid' }
  | { readonly state: 'rate_limited'; readonly retryAfterSeconds: number }
  | { readonly state: 'error' };

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
  channel: PublicUnsubscribeChannel,
): Promise<void> {
  // Routes through the typed F7 audit adapter (consistent with
  // PR #20's typed-emit pattern + Constitution Principle III barrel
  // discipline) rather than a raw `db.execute(sql\`INSERT…\`)`. The
  // adapter accepts `tx=null` for pre-tenant pathways and falls back
  // to the system `db` handle, and `f7RetentionFor(eventType)` derives
  // the 5y retention from the typed event union — so a future spec
  // amendment promoting any F7 event to 10y propagates here without
  // a hardcoded literal at the call site.
  try {
    // T198 T-F7-05 (Phase 10) — sourceIp is GDPR Art. 4(1) PII; stored
    // raw in a 5y-retention column violates data-minimisation. Hash
    // before persistence; first 12 hex chars of sha256 are sufficient
    // for cross-request correlation while making the original IP
    // unrecoverable from a DB dump.
    const sourceIpHash = `sha256:${sha256Hex(sourceIp).slice(0, 12)}`;
    await f7AuditAdapter.emit(null, {
      eventType: 'broadcast_unsubscribe_token_invalid',
      actorUserId: 'system:public_unsubscribe',
      summary: `Public unsubscribe rejected: ${failureReason}`,
      payload: { failureReason, sourceIpHash, channel },
      tenantId,
      requestId,
    });
  } catch (e) {
    logger.error(
      { err: (e as Error).message, failureReason, requestId },
      'unsubscribe_invalid_audit_emit_failed',
    );
  }
}

/** `null` = under the limit (or limiter down — fail open). */
async function rateLimitRetryAfter(
  key: string,
  requestId: string,
): Promise<number | null> {
  try {
    const rl = await broadcastsRateLimiter.checkLimit(
      key,
      UNSUBSCRIBE_RATE_LIMIT_MAX,
      UNSUBSCRIBE_RATE_LIMIT_WINDOW_S,
    );
    return rl.ok ? null : rl.error.retryAfterSeconds;
  } catch (e) {
    logger.warn(
      { err: (e as Error).message, requestId },
      'unsubscribe_rate_limit_check_failed',
    );
    return null;
  }
}

/**
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
  channel: PublicUnsubscribeChannel = 'page_get',
): Promise<{ readonly outcome: UnsubscribeOutcome; readonly locale: Locale }> {
  const startedAt = Date.now();
  const recordTtfb = (tenantIdLabel: string | null): void => {
    broadcastsMetrics.unsubscribePageTtfbMs(
      tenantIdLabel,
      Date.now() - startedAt,
    );
  };

  const rateLimited = async (
    retryAfterSeconds: number,
    tokenLang: Locale | undefined,
    audit: boolean,
  ): Promise<{ readonly outcome: UnsubscribeOutcome; readonly locale: Locale }> => {
    if (audit) {
      await emitInvalidTokenAudit(null, 'rate_limited', sourceIp, requestId, channel);
    }
    broadcastsMetrics.unsubscribesCount(null, 'rate_limited');
    recordTtfb(null);
    return {
      outcome: { state: 'rate_limited', retryAfterSeconds },
      locale: resolveLocale(tokenLang, queryLang, acceptLanguage, null),
    };
  };

  // Centralise the "invalid outcome + audit + counter + record TTFB" exit
  // path so the reject branches below stay consistent (any divergence here
  // is a Principle I append-only signal-loss bug).
  const reject = async (
    reason: string,
    tenantIdLabel: string | null,
    tokenLang: Locale | undefined,
  ): Promise<{ readonly outcome: UnsubscribeOutcome; readonly locale: Locale }> => {
    if (channel === 'one_click_post') {
      const retryAfter = await rateLimitRetryAfter(
        `unsubscribe-post-fail:${sourceIp}`,
        requestId,
      );
      if (retryAfter !== null) return rateLimited(retryAfter, tokenLang, false);
    }
    await emitInvalidTokenAudit(tenantIdLabel, reason, sourceIp, requestId, channel);
    broadcastsMetrics.unsubscribesCount(tenantIdLabel, 'invalid');
    recordTtfb(tenantIdLabel);
    return {
      outcome: { state: 'invalid' },
      locale: resolveLocale(tokenLang, queryLang, acceptLanguage, tenantIdLabel),
    };
  };

  // The page can be reached WITHOUT the proxy (Next skips the matcher for
  // prefetch requests) and READ_ONLY_MODE never froze GET, yet this
  // pipeline writes. Gate it here too: no write while F7 is off or the
  // deployment is frozen — the recipient sees "try again", nothing recorded.
  if (!env.features.f7Broadcasts || env.flags.readOnlyMode) {
    logger.warn(
      { requestId, channel, f7: env.features.f7Broadcasts, readOnly: env.flags.readOnlyMode },
      'unsubscribe_refused_feature_off_or_read_only',
    );
    recordTtfb(null);
    return {
      outcome: { state: 'error' },
      locale: resolveLocale(undefined, queryLang, acceptLanguage, null),
    };
  }

  if (channel === 'page_get') {
    const retryAfter = await rateLimitRetryAfter(`unsubscribe:${sourceIp}`, requestId);
    if (retryAfter !== null) return rateLimited(retryAfter, undefined, true);
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

  // Defence-in-depth: pre-tenant `peekTokenTenantId` parses `tid`
  // from the unauthenticated token to bind RLS, while `verify` re-parses
  // `tid` from the SAME base64url payload AFTER constant-time MAC
  // verification. Any divergence would let cross-tenant probes bind RLS
  // to one tenant while the suppression row writes to another — this
  // guard closes the window. Reject as `tenant_id_mismatch` (separate
  // audit category from `bad_signature`) so dashboards can spot drift.
  // R7 MED-S4 — `tenantId` is `UnverifiedTenantSlug` (peek), `payload.tenantId`
  // is `TenantSlug` (verified). Compare as plain strings.
  if ((payload.tenantId as string) !== (tenantId as string)) {
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

  const locale = resolveLocale(
    payload.lang,
    queryLang,
    acceptLanguage,
    payload.tenantId,
  );

  // Top-level guard: every step from here on touches infrastructure
  // (tenant settings, RLS bind, DB upsert) and may throw on transient
  // outages. Collapse any throw into the retry-state error outcome.
  // Fallback uses the localised "the chamber" string rather than echoing
  // the raw tenant slug — slugs read as internal identifiers ("swecham").
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
    env.broadcasts.privacyContactEmail,
  );

  let result;
  try {
    result = await runInTenant(tenantCtx, async () =>
      unsubscribeRecipient(deps, {
        tenantId: payload.tenantId,
        broadcastId: asBroadcastId(payload.broadcastId),
        emailLower: payload.emailLower,
        tokenPlaintext: tokenPlain,
        channel,
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
    return { outcome: { state: 'error' }, locale };
  }

  if (!result.ok) {
    // Distinguish transient infrastructure failure (`repo_error`) from
    // a token / business-rule rejection. The recipient sees a distinct
    // "please try again" state, not the misleading "link invalid" — their
    // unsubscribe was NOT recorded.
    if (result.error.kind === 'unsubscribe.repo_error') {
      logger.error(
        { kind: result.error.kind, requestId },
        'unsubscribe_repo_error',
      );
      broadcastsMetrics.unsubscribesCount(payload.tenantId, 'repo_error');
      recordTtfb(payload.tenantId);
      return { outcome: { state: 'error' }, locale };
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
    },
    locale,
  };
}
