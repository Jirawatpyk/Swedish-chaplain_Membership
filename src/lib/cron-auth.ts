/**
 * Constant-time Bearer-token check for cron routes.
 *
 * Byte-length check first because `timingSafeEqual` throws on length
 * mismatch; treats null/missing/short/long header as auth failure
 * with no timing leak on `CRON_SECRET` enumeration.
 *
 * M-8 (review 2026-04-27): compare UTF-8 byte length, not UTF-16
 * String#length. ASCII-only secrets are unaffected, but a multi-byte
 * `CRON_SECRET` (Thai chars / emoji) would mismatch UTF-16 length vs
 * UTF-8 buffer length and let `timingSafeEqual` throw on a different
 * comparison path than the early-return — leaking a timing channel.
 */
import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { logger } from '@/lib/logger';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { getClientIp } from '@/lib/client-ip';
import { uuidv7 } from '@/lib/request-id';
import { env } from '@/lib/env';
// `@/lib/auth-deps` + `@/modules/renewals` are imported lazily inside
// `gateCronBearerOrRespond` so that the lightweight `verifyCronBearer`
// callers (8 cron routes that only need the bearer check) don't drag
// the rate-limiter + renewals composition root through their bundle.
// Tests that mock `env` partially (e.g. `tests/contract/broadcasts/...`)
// stub only `env.features` + `env.cron` + `env.tenant`; eager-importing
// `auth-deps` would crash at module-init reading `env.upstash.url`.

export function verifyCronBearer(
  authHeader: string | null | undefined,
  expectedSecret: string,
): boolean {
  const expectedHeader = `Bearer ${expectedSecret}`;
  const provided = authHeader ?? '';
  if (
    Buffer.byteLength(provided, 'utf8') !==
    Buffer.byteLength(expectedHeader, 'utf8')
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expectedHeader, 'utf8'),
  );
}

/**
 * Round-4 review-finding C2: shared cron-auth gate that combines
 * Bearer verification + IP rate-limit on rejection + `cron_bearer_auth_rejected`
 * audit emit. Three F8 cron coordinators (`at-risk-recompute`, `lapse-cycles-on-grace-expiry`,
 * `reconcile-pending-reactivations`) previously duplicated this logic inline,
 * with two of three SILENTLY 401-ing without emitting the security audit
 * — Constitution Principle I clause 4 violation. Extracting here ensures
 * uniform behaviour across every coordinator that adopts it.
 *
 * Returns:
 *   - `null` on success → caller proceeds with the cron body.
 *   - `NextResponse` (401 + audit emitted, or 429 + rate-limit) → caller
 *     immediately returns it.
 *
 * The `route` label is written into the audit payload so SRE can
 * distinguish probe sources across cron endpoints.
 *
 * Fail-open on rate-limit-check failure (Upstash outage): logs
 * `cron.coordinator.rate_limit_check_failed_fail_open` then proceeds
 * with the audit emit + 401 (denying access is the safe direction).
 *
 * Fail-open on audit-emit failure: logs
 * `cron.coordinator.bearer_rejected_audit_failed` and still returns 401
 * (security gate must not be skipped because compliance trail failed —
 * the metric counter `coordinatorAuditEmitFailed` lets SRE alert on
 * sustained loss).
 */
export async function gateCronBearerOrRespond(
  request: NextRequest,
  options: {
    readonly route: string;
    /**
     * Invoked when the audit emit fails on the 401 path. Pass
     * `renewalsMetrics.coordinatorAuditEmitFailed(...)` (or feature-
     * specific equivalent) so Vercel alert rules can fire on sustained
     * audit-trail loss.
     */
    readonly metricsCounter?: () => void;
    /**
     * R5-BLK-1 closure (staff-review-2026-05-09 Round 2): invoked when
     * the rate-limiter check throws (Upstash outage) on the 401 path.
     * Pass `renewalsMetrics.redisFallback()` (or feature-specific
     * equivalent) so Vercel alert rules — which attach to OTel
     * counters not log strings — can fire on sustained Upstash
     * degradation. K14-5 / R13-W3 invariant preserved across the
     * helper migration.
     */
    readonly rateLimitFallbackCounter?: () => void;
  },
): Promise<NextResponse | null> {
  if (verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return null;
  }

  const ip = getClientIp(request);
  // Lazy-load — see top-of-file note for rationale.
  const { rateLimiter } = await import('@/lib/auth-deps');
  const { makeRenewalsDeps } = await import('@/modules/renewals');
  try {
    const rl = await rateLimiter.check(
      `f8:cron:bearer-rejected:${ip}`,
      60,
      60,
    );
    if (!rl.success) {
      return NextResponse.json(
        { error: { code: 'rate_limited' } },
        {
          status: 429,
          headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
        },
      );
    }
  } catch (e) {
    const errInstance = e instanceof Error ? e : new Error(String(e));
    logger.warn(
      {
        errMsg: errInstance.message.slice(0, 200),
        errName: errInstance.name,
        errStack: errInstance.stack?.slice(0, 500),
        ip,
        route: options.route,
      },
      'cron.coordinator.rate_limit_check_failed_fail_open',
    );
    options.rateLimitFallbackCounter?.();
  }

  try {
    const deps = makeRenewalsDeps(env.tenant.slug);
    await deps.auditEmitter.emit(
      {
        type: 'cron_bearer_auth_rejected',
        payload: { route: options.route },
      },
      {
        tenantId: env.tenant.slug,
        actorUserId: null,
        actorRole: 'cron',
        correlationId: uuidv7(),
        requestId: null,
      },
    );
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)), route: options.route },
      'cron.coordinator.bearer_rejected_audit_failed',
    );
    options.metricsCounter?.();
  }

  return NextResponse.json(
    { error: { code: 'unauthorized' } },
    { status: 401 },
  );
}
