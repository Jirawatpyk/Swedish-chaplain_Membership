import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { checkCsrf } from '@/lib/csrf';
import { REQUEST_ID_HEADER, requestIdFromHeaders } from '@/lib/request-id';

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
 * page server components (via the `getSession()` helper added in Phase 3),
 * not here, because Edge runtime cannot import postgres-js (Node.js APIs).
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
// A future hardening pass in Phase 10 should switch the prod policy to
// nonce-based script-src and drop unsafe-inline too.
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
  //    (x-pathname lets server components read the current URL via
  //    `headers()` so e.g. `requireSession()` can build a returnTo
  //    query param — Next.js does not expose the pathname to server
  //    components otherwise.)
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set('x-pathname', nextUrl.pathname + nextUrl.search);
  forwardedHeaders.set(REQUEST_ID_HEADER, requestId);
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
