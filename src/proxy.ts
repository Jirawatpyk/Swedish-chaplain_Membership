import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { checkCsrf } from '@/lib/csrf';
import { REQUEST_ID_HEADER, requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';

/**
 * F2 tenant header — forwarded to route handlers + server components so
 * they can assert/log the active tenant without re-running the resolver
 * on every request. Route handlers still call `resolveTenantFromRequest`
 * themselves (which returns the exact same `TenantContext` brand) — the
 * header is a **paper trail** for observability, not the source of
 * truth. F10 will change the resolver to parse the request and this
 * header will then carry whatever the resolver extracted (subdomain,
 * session claim, etc.) without any other code change.
 */
export const TENANT_SLUG_HEADER = 'x-tenant-slug';

/**
 * Main Next.js Proxy handler (T043, research.md § 4 / § 5, plan.md § Constraints).
 *
 * **Next.js 16 rename**: what was previously `middleware.ts` is now
 * `proxy.ts` with an exported `proxy()` function. See
 * https://nextjs.org/docs/messages/middleware-to-proxy — the rename
 * is cosmetic (Next.js renamed the convention because "middleware"
 * collided with Express.js semantics; "proxy" better describes the
 * network-boundary role). NextRequest / NextResponse / `config.matcher`
 * are unchanged.
 *
 * Responsibilities:
 *   1. Inject a request ID (UUIDv7) into every request and response.
 *   2. Enforce READ_ONLY_MODE — every state-changing request returns 503.
 *   3. Enforce the CSRF Origin allow-list for /api/* state-changing requests
 *      (except `/api/webhooks/*` and `/api/cron/*` which authenticate via
 *      HMAC signature / Bearer token — see src/lib/csrf.ts EXEMPT_PATH_PREFIXES).
 *   4. Set HSTS, CSP, X-Frame-Options, and other security headers on every
 *      response (single source of truth — next.config.ts intentionally has
 *      none, so all headers live here).
 *
 * Session lookup + lockout enforcement happens INSIDE Route Handlers and
 * page server components (via the `getCurrentSession()` helper in
 * `src/lib/auth-session.ts`), not here, because Edge runtime cannot
 * import postgres-js (Node.js APIs).
 *
 * Per Next.js 16 docs, runtime defaults to nodejs since v15.5+; we keep
 * the default so `@/lib/env` and `@/lib/csrf` (which depend on Node)
 * load without issues.
 */

const HSTS_VALUE = 'max-age=63072000; includeSubDomains; preload';

// script-src: `'unsafe-inline'` is kept because Next.js inlines small
// bootstrap scripts for hydration. In DEV we ALSO add `'unsafe-eval'`
// because React DevTools + HMR + the error-overlay stack reconstruction
// all call `eval()` under the hood — with strict CSP the browser blocks
// them and the dev overlay shows a console error. Production has eval
// disabled (React production bundles never call it).
//
// A future hardening pass (tracked as an F1 ship-gate follow-up)
// should switch the prod policy to nonce-based script-src and drop
// unsafe-inline too.
function buildCsp(isDevelopment: boolean): string {
  const scriptSrc = isDevelopment
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  // Dev needs ws:// for HMR socket; prod only allows https:.
  const connectSrc = isDevelopment
    ? "connect-src 'self' https: ws: wss:"
    : "connect-src 'self' https:";

  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    connectSrc,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

const CSP_VALUE = buildCsp(env.isDevelopment);

function applySecurityHeaders(response: NextResponse): NextResponse {
  response.headers.set('Strict-Transport-Security', HSTS_VALUE);
  response.headers.set('Content-Security-Policy', CSP_VALUE);
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
}

export function proxy(request: NextRequest): NextResponse {
  const { method, nextUrl } = request;
  const requestId = requestIdFromHeaders(request.headers);
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  // 1. READ_ONLY_MODE — block all writes with 503 (used for rollback /
  //    scheduled maintenance per .env.local README).
  if (env.flags.readOnlyMode && isStateChanging) {
    const response = NextResponse.json(
      {
        error: 'read-only-mode',
        message: 'The system is currently in read-only mode for maintenance.',
      },
      { status: 503 },
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    response.headers.set('Retry-After', '300');
    return applySecurityHeaders(response);
  }

  // 1b. FEATURE_F3_MEMBERS kill-switch (T036) — when false, every member /
  //     portal route returns 503 read_only_mode without a code deploy.
  //     Applies to BOTH reads and writes on the F3 surfaces because the
  //     whole feature is disabled, not just mutations.
  const isF3Path =
    nextUrl.pathname.startsWith('/api/members') ||
    nextUrl.pathname.startsWith('/api/portal');
  if (!env.features.f3Members && isF3Path) {
    const response = NextResponse.json(
      {
        error: 'read_only_mode',
        message: 'Member directory is temporarily unavailable.',
      },
      { status: 503 },
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    response.headers.set('Retry-After', '300');
    return applySecurityHeaders(response);
  }

  // 1c. FEATURE_F4_INVOICING kill-switch (T020) — when false, every
  //     invoicing route returns 503 read_only_mode. Applies to BOTH
  //     reads and writes on F4 surfaces. Member-portal /api/portal/invoices
  //     is a dedicated sub-path (added in US3) and is gated here too; the
  //     F3 /api/portal guard above only triggers when F3 itself is off.
  //
  //     R7-B4 fix — the cron dispatcher is a SHARED route
  //     (`/api/cron/outbox-dispatch`) serving F1 + F4 rows. Blanket-
  //     blocking it here would stop F1 emails too. The kill-switch for
  //     F4 outbox rows lives INSIDE the dispatcher query which filters
  //     `notification_type != 'invoice_auto_email'` when f4Invoicing is
  //     false (see src/app/api/cron/outbox-dispatch/route.ts). The
  //     previous `/api/cron/auto-email-dispatch` reference was a
  //     path-mismatch that gave the kill-switch no actual containment
  //     power over in-flight invoice email dispatch.
  const isF4Path =
    nextUrl.pathname.startsWith('/api/invoices') ||
    nextUrl.pathname.startsWith('/api/credit-notes') ||
    nextUrl.pathname.startsWith('/api/tenant-invoice-settings') ||
    nextUrl.pathname.startsWith('/api/portal/invoices');
  if (!env.features.f4Invoicing && isF4Path) {
    const response = NextResponse.json(
      {
        error: 'read_only_mode',
        message: 'Invoicing is temporarily unavailable.',
      },
      { status: 503 },
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    response.headers.set('Retry-After', '300');
    return applySecurityHeaders(response);
  }

  // 2. CSRF Origin allow-list for /api/* state-changing requests
  const csrfDecision = checkCsrf(method, nextUrl.pathname, request.headers.get('origin'));
  if (csrfDecision.action === 'reject') {
    const response = NextResponse.json(
      {
        error: 'csrf-rejected',
        reason: csrfDecision.reason,
      },
      { status: 403 },
    );
    response.headers.set(REQUEST_ID_HEADER, requestId);
    return applySecurityHeaders(response);
  }

  // 3. Pass-through with security headers + request ID + x-pathname
  //    + x-tenant-slug (F2).
  //    (x-pathname lets server components read the current URL via
  //    `headers()` so e.g. `requireSession()` can build a returnTo
  //    query param — Next.js does not expose the pathname to server
  //    components otherwise.)
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set('x-pathname', nextUrl.pathname + nextUrl.search);
  forwardedHeaders.set(REQUEST_ID_HEADER, requestId);

  // F2: resolve tenant once in the proxy so every downstream consumer
  // (route handlers, server components, logs) sees the same slug. In F2
  // this is a constant from env; in F10 it will parse the request URL /
  // session claim. Wrapped in try/catch because a malformed env var
  // would otherwise take down every request — if resolution fails, we
  // log + skip the header and let the route handler's call to
  // `resolveTenantFromRequest` surface the real error on its own terms.
  try {
    const tenant = resolveTenantFromRequest(request);
    forwardedHeaders.set(TENANT_SLUG_HEADER, tenant.slug);
  } catch {
    // Intentionally silent — resolver would have already failed at boot
    // if env.TENANT_SLUG was malformed; this catch guards against a
    // future F10 resolver that throws for unauthenticated requests on
    // tenant-unknown routes (landing page, public docs, etc.).
  }

  const response = NextResponse.next({
    request: {
      headers: forwardedHeaders,
    },
  });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return applySecurityHeaders(response);
}

/**
 * Match every request EXCEPT static assets (which Next.js serves via the
 * file system — no point running the proxy on the favicon).
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
