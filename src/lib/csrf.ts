import { env } from './env';

/**
 * CSRF Origin-header allow-list (T041, research.md § 4.1, security.md T-07).
 *
 * `/api/auth/*` Route Handlers do NOT inherit Next.js Server Actions'
 * automatic CSRF protection, so we enforce a hard Origin allow-list on
 * every state-changing POST / PUT / PATCH / DELETE.
 *
 * Algorithm (research.md § 4.1):
 *
 *     IF method NOT IN [POST, PUT, PATCH, DELETE]: pass
 *     IF path DOES NOT match /^\/api\//:           pass
 *     IF Origin header is absent:                  reject
 *     IF Origin NOT IN APP_ALLOWED_ORIGINS:        reject
 *     ELSE:                                        pass
 *
 * Why Origin over double-submit cookie:
 *   - Browsers set Origin automatically; scripts cannot forge it cross-origin.
 *   - Single point of enforcement (this file + proxy.ts).
 *   - Zero client-side ceremony.
 *
 * Caveat: Safari sometimes sends `Origin: null` on same-origin redirects.
 * That edge case is rejected here — F1 has no flows that cross redirect
 * boundaries during a POST, so it doesn't matter in practice.
 */

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PROTECTED_PATH_PREFIX = '/api/';

/**
 * Paths that are NOT browser-driven and therefore NOT subject to the
 * Origin header check. These are authenticated by OTHER means:
 *
 *   - `/api/webhooks/*` — authenticated by upstream provider's HMAC
 *     signature (e.g. Svix `svix-signature` header for Resend). Origin
 *     is never sent by a server-to-server webhook caller, so enforcing
 *     it here would block every webhook delivery.
 *   - `/api/cron/*` — authenticated by a Bearer `CRON_SECRET` token
 *     set by Vercel Cron. Vercel Cron does not send an Origin header.
 *   - `/api/internal/*` — authenticated by a Bearer `CRON_SECRET` token
 *     via `gateCronBearerOrRespond` (`src/lib/cron-auth.ts`). External
 *     cron-job.org coordinators (F4 outbox-purge, F5 stale-pending-count,
 *     F6 pseudonymise + idempotency sweep + recompute-match-rate, F6.1
 *     error-csv-blob sweep) POST/GET here as server-to-server clients
 *     without an Origin header. Adding this prefix prevents the CSRF
 *     guard from blocking the request before the Bearer check runs
 *     (security review 2026-05-17 finding — see `ship-day-checklist.md`).
 *
 * Everything else under `/api/` still goes through the Origin allow-list.
 */
const EXEMPT_PATH_PREFIXES = ['/api/webhooks/', '/api/cron/', '/api/internal/'];

export type CsrfDecision =
  | {
      readonly action: 'pass';
      readonly reason:
        | 'method-safe'
        | 'unprotected-path'
        | 'exempt-path'
        | 'origin-allowed';
    }
  | { readonly action: 'reject'; readonly reason: 'missing-origin' | 'origin-not-allowed' };

/**
 * In development mode we accept any `http://localhost:<port>` or
 * `http://127.0.0.1:<port>` origin so the dev workflow works across
 * whatever port `pnpm dev` happens to use (3000 for normal dev, 3100
 * for Playwright, etc.). Production still requires an explicit match
 * against `APP_ALLOWED_ORIGINS`.
 */
const DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

export function checkCsrf(method: string, pathname: string, origin: string | null): CsrfDecision {
  const upper = method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(upper)) {
    return { action: 'pass', reason: 'method-safe' };
  }
  if (!pathname.startsWith(PROTECTED_PATH_PREFIX)) {
    return { action: 'pass', reason: 'unprotected-path' };
  }
  // Server-to-server endpoints (webhooks, cron) authenticate via their
  // own signature / bearer-token mechanisms and never receive an Origin
  // header. Exempt them from the browser-centric CSRF guard.
  for (const prefix of EXEMPT_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      return { action: 'pass', reason: 'exempt-path' };
    }
  }
  if (!origin) {
    return { action: 'reject', reason: 'missing-origin' };
  }
  if (env.app.allowedOrigins.includes(origin)) {
    return { action: 'pass', reason: 'origin-allowed' };
  }
  if (env.isDevelopment && DEV_ORIGIN_PATTERN.test(origin)) {
    return { action: 'pass', reason: 'origin-allowed' };
  }
  return { action: 'reject', reason: 'origin-not-allowed' };
}
