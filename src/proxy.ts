import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { checkCsrf } from '@/lib/csrf';
import { REQUEST_ID_HEADER, requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

/**
 * Staff-review R2 R023 (2026-04-28) — per-request nonce header forwarded
 * to server components so they can attach `nonce={nonce}` to any inline
 * `<script>` they render. Next.js 16 picks this up automatically for its
 * own bootstrap scripts when the header is present.
 */
export const NONCE_HEADER = 'x-nonce';

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
 * True when `pathname` is an F7 (E-Blast) surface that the
 * `FEATURE_F7_BROADCASTS` kill-switch must cover. Extracted as a pure,
 * exported predicate so the exact path set is unit-testable (bug #15) — a
 * missed prefix silently leaves an F7 state-changing route writable while the
 * feature is supposedly dark.
 */
export function matchesF7KillSwitchPath(pathname: string): boolean {
  return (
    pathname.startsWith('/api/broadcasts') ||
    pathname.startsWith('/api/admin/broadcasts') ||
    // Bug #15 fix (2026-07-10): the member "acknowledge broadcasts terms" API
    // lives under /api/portal/broadcasts, NOT /api/broadcasts, so it slipped
    // the kill-switch and stayed writable with F7 disabled.
    pathname.startsWith('/api/portal/broadcasts') ||
    // Code-review follow-up (2026-07-11): the member snapshot-template write
    // route lives under /api/member/broadcasts and self-gates only on the
    // F7.1a-US7 sub-flag; cover it with the master F7 kill-switch too.
    pathname.startsWith('/api/member/broadcasts') ||
    pathname.startsWith('/api/webhooks/resend-broadcasts') ||
    // Bug #15 fix: the admin "clear broadcasts halt" API is nested under
    // /api/admin/members/<id>/…, so neither /api/admin/broadcasts nor the
    // /admin/broadcasts page-regex matched it — an admin could still mutate
    // broadcasts_halted_until_admin_review while F7 was frozen.
    /^\/api\/admin\/members\/[^/]+\/broadcasts-halt-clear(?:\/|$)/.test(
      pathname,
    ) ||
    /^\/unsubscribe(?:\/|$)/.test(pathname) ||
    /^\/portal\/broadcasts(?:\/|$)/.test(pathname) ||
    /^\/admin\/broadcasts(?:\/|$)/.test(pathname) ||
    /^\/portal\/benefits\/e-blasts(?:\/|$)/.test(pathname)
  );
}

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

// script-src — nonce-based (CSP Level 3) per staff-review R2 R023.
//
// Production: `'nonce-${nonce}'` + `'strict-dynamic'`. The nonce is fresh
// per request (16 bytes base64). `'unsafe-inline'` is kept ONLY as a
// fallback for legacy browsers — CSP Level 3 spec says modern browsers
// ignore `'unsafe-inline'` when a `'nonce-*'` source is present, so this
// is a defense-in-depth posture. PCI DSS 6.4.1 best practice met because
// inline scripts without the nonce are blocked on every browser shipped
// in the past 5 years (Chrome 59+, FF 49+, Safari 15.4+).
//
// Development: `'unsafe-inline'` + `'unsafe-eval'` is kept because React
// DevTools + Turbopack HMR + error-overlay stack reconstruction all call
// `eval()` under the hood. Production React bundles never call eval, so
// dropping `'unsafe-eval'` in prod is safe.
/**
 * F5 — Stripe origins are allowed in CSP application-wide.
 *
 * History: route-scoped allowlist was tried first (only enabled on
 * `/portal/invoices/...` + `/admin/invoices/...`) but **breaks under
 * Next.js SPA navigation**. CSP is an HTTP header applied at the
 * initial document load; client-side route changes via `<Link>` do
 * NOT re-evaluate CSP, so a user landing first on `/portal/dashboard`
 * (Stripe-disallowed CSP) and then SPA-navigating to an invoice
 * detail keeps the dashboard's CSP — Stripe.js is blocked.
 *
 * The "scoping" benefit was minimal anyway: Stripe.js is not an XSS
 * vector (it loads an iframe sandbox). Keeping it global matches
 * Stripe's official documentation and how every other Stripe-using
 * app is configured. Webhook route (`/api/webhooks/stripe`) is
 * server-only and does not exercise these directives.
 */

/**
 * Generate a 16-byte cryptographically-strong nonce, base64-encoded.
 * Web Crypto is available in both Edge and Node runtimes (Next.js 16+).
 */
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // base64-encode without using Node Buffer so this works on Edge too.
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function buildCsp(isDevelopment: boolean, nonce: string): string {
  const scriptSrcParts = isDevelopment
    ? [
        "'self'",
        "'unsafe-inline'",
        "'unsafe-eval'",
        'https://js.stripe.com',
      ]
    : [
        "'self'",
        `'nonce-${nonce}'`,
        // 'strict-dynamic' lets nonce'd scripts load further scripts
        // without each carrying a nonce — required for Next.js's
        // hydration bootstrap. Modern browsers prefer this over the
        // host allowlist for nonce'd scripts.
        "'strict-dynamic'",
        // Fallback for legacy browsers without CSP3 nonce support.
        // CSP3-aware browsers ignore `'unsafe-inline'` when a `'nonce-*'`
        // source is present (per W3C CSP Level 3 § 6.7.2).
        "'unsafe-inline'",
        // Stripe must remain in script-src as an explicit host since
        // 'strict-dynamic' is in play (the nonce'd loader fetches
        // Stripe.js — strict-dynamic propagates trust, but Stripe's
        // documented integration relies on the host allowlist as
        // backwards-compatible defense).
        'https://js.stripe.com',
      ];
  const frameSrcParts = [
    "'self'",
    'https://js.stripe.com',
    'https://hooks.stripe.com',
  ];
  // Dev needs ws:// for HMR socket; prod only allows https:.
  const connectSrcParts = [
    "'self'",
    ...(isDevelopment ? ['https:', 'ws:', 'wss:'] : ['https:']),
    'https://api.stripe.com',
  ];

  return [
    "default-src 'self'",
    `script-src ${scriptSrcParts.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrcParts.join(' ')}`,
    `frame-src ${frameSrcParts.join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function applySecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set('Strict-Transport-Security', HSTS_VALUE);
  response.headers.set(
    'Content-Security-Policy',
    buildCsp(env.isDevelopment, nonce),
  );
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return response;
}

/**
 * Retry window for all kill-switch 503s. Mirrored as `Retry-After` header
 * AND `retryAfterSeconds` body field so route handlers + member-portal
 * error boundaries can render a countdown without parsing headers (some
 * fetch wrappers strip them).
 */
const KILL_SWITCH_RETRY_AFTER_SECONDS = 300;

/**
 * Canonical machine-readable body schema for every 503 kill-switch /
 * read-only block. Phase 3+ route handlers and portal error boundaries
 * branch on `error` (code) to pick the right toast + i18n key, and use
 * `retryAfterSeconds` / `supportUrl` to shape the CTA.
 *
 * `message` is EN-only and is a safety fallback — the caller SHOULD
 * translate `error` via an i18n key instead of rendering `message`
 * verbatim (proxy runs before locale detection; no translation
 * available here).
 */
function build503(
  errorCode: string,
  message: string,
  pathname: string,
  requestId: string,
  nonce: string,
): NextResponse {
  const response = NextResponse.json(
    {
      error: errorCode,
      message,
      retryAfterSeconds: KILL_SWITCH_RETRY_AFTER_SECONDS,
      supportUrl: '/admin/support',
    },
    { status: 503 },
  );
  response.headers.set(REQUEST_ID_HEADER, requestId);
  response.headers.set('Retry-After', String(KILL_SWITCH_RETRY_AFTER_SECONDS));
  return applySecurityHeaders(response, nonce);
}

export function proxy(request: NextRequest): NextResponse {
  const { method, nextUrl } = request;
  const requestId = requestIdFromHeaders(request.headers);
  const nonce = generateNonce();
  const isStateChanging = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  // 1. READ_ONLY_MODE — block all writes with 503 (used for rollback /
  //    scheduled maintenance per .env.local README).
  //
  //    F-stack cron handlers (`POST /api/cron/**`) are intentionally
  //    INCLUDED in this gate. Rationale: an emergency write-freeze IS
  //    intended to halt all state-mutating server work, including
  //    scheduled jobs — otherwise a cron pass during the freeze could
  //    corrupt state the operator is trying to stabilise. Cron-job.org
  //    will log 503s but does not retry-storm because each cron entry
  //    has retry-disabled per `docs/runbooks/cron-jobs.md` § "Retry
  //    policy contract". F8 cron specifically: missed dispatch /
  //    lapse-cycle / at-risk passes during a typical <24h freeze
  //    window are acceptable — the next pass picks up where the
  //    previous one left off (idempotent FR-011 + state-machine
  //    convergence). If a future feature has time-critical cron that
  //    MUST run during freeze (e.g., regulatory deadline), add an
  //    explicit carve-out here with a paired Constitution amendment.
  if (env.flags.readOnlyMode && isStateChanging) {
    return build503(
      'read-only-mode',
      'The system is currently in read-only mode for maintenance.',
      nextUrl.pathname,
      requestId,
      nonce,
    );
  }

  // 1b. FEATURE_F3_MEMBERS kill-switch (T036). Applies to BOTH reads and
  //     writes on the F3 surfaces because the whole feature is disabled.
  //
  //     Deep-review fix — F8 portal API surfaces (`/api/portal/renewal/**`
  //     + `/api/portal/preferences/renewals`) are nested under
  //     `/api/portal` but DO NOT belong to F3. The earlier blanket match
  //     would silently kill F8 portal endpoints with the wrong error
  //     code (`read_only_mode` instead of `feature_disabled`) when an
  //     operator disabled F3 for maintenance while F8 was live. We now
  //     exclude the F8 portal sub-trees so each kill-switch returns its
  //     own canonical error code.
  const isF8PortalApiPath =
    nextUrl.pathname.startsWith('/api/portal/renewal') ||
    nextUrl.pathname.startsWith('/api/portal/preferences/renewals');
  const isF3Path =
    nextUrl.pathname.startsWith('/api/members') ||
    (nextUrl.pathname.startsWith('/api/portal') && !isF8PortalApiPath);
  if (!env.features.f3Members && isF3Path) {
    return build503(
      'read_only_mode',
      'Member directory is temporarily unavailable.',
      nextUrl.pathname,
      requestId,
      nonce,
    );
  }

  // 1c. FEATURE_F4_INVOICING kill-switch (T020). Applies to BOTH reads
  //     and writes on F4 surfaces.
  //
  //     R7-B4 — the cron dispatcher is a SHARED route
  //     (`/api/cron/outbox-dispatch`) serving F1 + F4 rows. Blanket-
  //     blocking it here would stop F1 emails too. The F4-row filter
  //     lives INSIDE the dispatcher query which drops
  //     `notification_type == 'invoice_auto_email'` when f4Invoicing is
  //     false (see src/app/api/cron/outbox-dispatch/route.ts).
  const isF4Path =
    nextUrl.pathname.startsWith('/api/invoices') ||
    nextUrl.pathname.startsWith('/api/credit-notes') ||
    nextUrl.pathname.startsWith('/api/tenant-invoice-settings') ||
    nextUrl.pathname.startsWith('/api/portal/invoices') ||
    // US7 — /api/members/<uuid>/invoices is an F4 read surface embedded
    // under the F3 members namespace; gate it under the F4 kill-switch
    // so "invoicing disabled" is uniform across every F4-bearing route.
    /^\/api\/members\/[^/]+\/invoices(?:\/|$)/.test(nextUrl.pathname);
  if (!env.features.f4Invoicing && isF4Path) {
    return build503(
      'read_only_mode',
      'Invoicing is temporarily unavailable.',
      nextUrl.pathname,
      requestId,
      nonce,
    );
  }

  // 1d. FEATURE_F5_ONLINE_PAYMENT kill-switch. Covers webhook + API
  //     routes AND the member-facing /pay page + admin refund page.
  //     Default OFF (dark ship); flip ON in Vercel env after Rolling
  //     Release gate. Distinct error code `feature_disabled` separates
  //     "not yet activated" from F3/F4's `read_only_mode` maintenance
  //     semantics so Phase 3 UI can pick the right microcopy.
  const isF5Path =
    nextUrl.pathname.startsWith('/api/payments') ||
    nextUrl.pathname.startsWith('/api/refunds') ||
    nextUrl.pathname.startsWith('/api/webhooks/stripe') ||
    nextUrl.pathname.startsWith('/api/tenant-payment-settings') ||
    /^\/portal\/invoices\/[^/]+\/pay(?:\/|$)/.test(nextUrl.pathname);
  if (!env.features.f5OnlinePayment && isF5Path) {
    return build503(
      'feature_disabled',
      'Online payment is temporarily unavailable.',
      nextUrl.pathname,
      requestId,
      nonce,
    );
  }

  // 1e. FEATURE_F7_BROADCASTS kill-switch (T031). Covers compose +
  //     submit + draft + quota API surfaces AND the public unsubscribe
  //     page (US5 / US4 future) + Resend webhook (US4). Default OFF
  //     (dark ship); flip ON in Vercel env after Phase 5 ship gate.
  //     Distinct error code `feature_disabled` separates "not yet
  //     activated" from F3/F4's `read_only_mode` maintenance semantics.
  const isF7Path = matchesF7KillSwitchPath(nextUrl.pathname);
  if (!env.features.f7Broadcasts && isF7Path) {
    return build503(
      'feature_disabled',
      'Email broadcasts are temporarily unavailable.',
      nextUrl.pathname,
      requestId,
      nonce,
    );
  }

  // 1f. FEATURE_F8_RENEWALS kill-switch (Phase 5 Wave A T133b). Default
  //     OFF (dark ship); flip ON in Vercel env after Phase 5+6+9 ship
  //     gates. Distinct error code `feature_disabled` separates "not yet
  //     activated" from F3/F4's `read_only_mode` maintenance semantics.
  //
  //     The proxy runs in Edge runtime — it CANNOT do DB lookups, so
  //     this block is path-prefix-only. The lapsed-portal-scope check
  //     (FR-005a / T133) lives in a route-handler/server-component
  //     helper that DOES have DB access; this proxy block only handles
  //     "feature globally disabled". The F8 paths covered:
  //
  //       - /api/cron/renewals/**        — daily dispatcher + reconcile-pending
  //       - /api/admin/renewals/**       — admin send-reminder-now etc.
  //       - /api/admin/members/*/(un)block-auto-reactivation — FR-005b admin override
  //       - /api/portal/renewal/**       — confirm POST + token-verify entry
  //       - /api/portal/preferences/renewals — FR-016 opt-out toggle
  //       - /admin/renewals/**           — admin pipeline + cycle pages
  //       - /portal/renewal/**           — public renewal page + success
  //       - /portal/preferences/renewals — opt-out preferences page
  //
  //     Kill-switch audit (`renewal_kill_switch_blocked`) emits from the
  //     individual route handlers / page components — proxy returns
  //     generic 503 without touching DB so we don't introduce edge-
  //     runtime Postgres dependencies. The audit row is the
  //     forensic record; the 503 is the user-facing block.
  const isF8Path =
    nextUrl.pathname.startsWith('/api/cron/renewals') ||
    nextUrl.pathname.startsWith('/api/admin/renewals') ||
    /^\/api\/admin\/members\/[^/]+\/(?:un)?block-auto-reactivation(?:\/|$)/.test(
      nextUrl.pathname,
    ) ||
    nextUrl.pathname.startsWith('/api/portal/renewal') ||
    nextUrl.pathname.startsWith('/api/portal/preferences/renewals') ||
    /^\/admin\/renewals(?:\/|$)/.test(nextUrl.pathname) ||
    // Deep-review fix — `/admin/settings/renewals/**` (schedule editor)
    // was previously NOT proxied; the page component had its own flag
    // guard, but defence-in-depth wants the proxy as first gate so a
    // disabled-F8 deploy doesn't render Next.js layouts + invoke
    // server-component data fetches before short-circuiting.
    /^\/admin\/settings\/renewals(?:\/|$)/.test(nextUrl.pathname) ||
    /^\/portal\/renewal(?:\/|$)/.test(nextUrl.pathname) ||
    /^\/portal\/preferences\/renewals(?:\/|$)/.test(nextUrl.pathname);
  if (!env.features.f8Renewals && isF8Path) {
    return build503(
      'feature_disabled',
      'Renewal reminders are temporarily unavailable.',
      nextUrl.pathname,
      requestId,
      nonce,
    );
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
    return applySecurityHeaders(response, nonce);
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
  // R023: forward the per-request nonce so server components can read it
  // via `headers()` and attach `nonce={nonce}` to any inline <script>
  // they render. Next.js 16 also reads `x-nonce` automatically for its
  // own hydration bootstrap scripts.
  forwardedHeaders.set(NONCE_HEADER, nonce);

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
  } catch (error) {
    // Resolver would have already failed at boot if env.TENANT_SLUG was
    // malformed; this catch guards against a future F10 resolver that
    // throws for unauthenticated requests on tenant-unknown routes
    // (landing page, public docs, etc.). Structured pino log — runs
    // through REDACT_PATHS so any error message containing session /
    // token data stays out of the log stream.
    logger.warn(
      {
        pathname: nextUrl.pathname,
        requestId,
        err: error instanceof Error ? error.message : String(error),
      },
      '[proxy] tenant resolver failed; header omitted',
    );
  }

  const response = NextResponse.next({
    request: {
      headers: forwardedHeaders,
    },
  });
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return applySecurityHeaders(response, nonce);
}

/**
 * Match every request EXCEPT static assets (which Next.js serves via the
 * file system — no point running the proxy on the favicon).
 */
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
