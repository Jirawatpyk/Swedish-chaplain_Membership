/**
 * Tenant-context resolver — turns an incoming request into a validated
 * `TenantContext` brand.
 *
 * **F2 behaviour** (single-tenant SweCham deployment): returns a
 * constant `asTenantContext(env.tenant.slug)` for every request. The
 * slug is validated at boot by `src/lib/env.ts` against the same
 * `[a-z0-9-]{1,63}` pattern that `asTenantContext` enforces, so an
 * invalid `TENANT_SLUG` env var fails server startup rather than
 * surfacing as a runtime error mid-request.
 *
 * **F10 behaviour** (multi-tenant rollout): replace the body of
 * `resolveTenantFromRequest` with subdomain / custom-domain / signed
 * session-claim parsing. **Zero changes** are required anywhere else —
 * every F2+ use case already takes `TenantContext` as an explicit
 * dependency, so the resolver swap is a one-file PR. See
 * `specs/002-membership-plans/research.md § 1.1` for the migration
 * path.
 *
 * **T115t test override** (2026-04-21): when `E2E_X_TENANT_HEADER_ENABLED=1`
 * is set AND the request carries an `X-Tenant` header, the resolver
 * returns the header value instead of `env.tenant.slug`. This enables
 * Playwright throwaway-tenant fixtures to drive mutating E2E tests
 * against per-test tenant rows without cross-contaminating the real
 * deployed tenant. The env flag is NEVER set in production
 * (validated + refused in `src/lib/env.ts` when NODE_ENV='production').
 * Without the flag the header is silently ignored, so a forgotten env
 * flag in a prod deploy cannot be weaponised by a malicious header.
 *
 * This file sits in `src/lib/**` which is on the Module side of the
 * Clean-Architecture barrel — it imports the type from the `tenants`
 * public barrel, not from the deep Domain file.
 */

import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { env } from './env';

const X_TENANT_HEADER = 'x-tenant';

/**
 * Server-component convenience for
 * tenant resolution.
 *
 * Server components do not receive a `Request` object — only a
 * `ReadonlyHeaders` from `headers()`. Prior code wrapped this in a
 * synthetic `new Request('http://localhost:3100', { headers })`
 * + cast it `as never` to satisfy `resolveTenantFromRequest`. The
 * cast pattern was spreading across F4/F6 page surfaces; this helper
 * centralises it so future tweaks (e.g. switching to a proper
 * `IncomingHeaders` overload on the resolver) happen in one file.
 *
 * @param headers — Result of `await headers()` from a server component.
 * @returns The resolved `TenantContext` brand.
 */
export function resolveTenantFromHeaders(
  headers: ReadonlyHeaders,
): TenantContext {
  // Resolver reads `x-tenant` only; all headers forwarded for
  // forward-compat (future signed-claim parsing). The flatten
  // throws ONLY when a future Next.js wrapper exposes a broken
  // ReadonlyHeaders Proxy — we deliberately let that exception
  // propagate (post-ship R6 C2, 2026-05-19). The prior try/catch
  // silently fell back to `env.tenant.slug` which violates
  // Constitution v1.4.0 Principle I (no silent tenant-isolation
  // fallbacks); in a future F10 multi-tenant rollout the fallback
  // would route requests to the deployed tenant by default, masking
  // cross-tenant routing bugs. Fail loud — Next.js error boundaries
  // catch the throw and render a 500 page; ops dashboards alert.
  const flat: Record<string, string> = {};
  headers.forEach((value, key) => {
    flat[key] = value;
  });
  // TODO(F10 multi-tenant): replace the synthetic `new Request(...)`
  // construction below with a proper headers-only overload on
  // `resolveTenantFromRequest`. The hardcoded `http://localhost:3100`
  // URL is harmless today (the resolver only inspects `x-tenant` +
  // host headers, never `pseudoReq.url`), but if a future signed-
  // claim resolver introspects the URL the bridge needs to disappear.
  // Phase 5 review-fix S-09 (2026-05-13) — marker for the MTA rollout
  // PR to surface this site.
  const pseudoReq = new Request('http://localhost:3100', { headers: flat });
  return resolveTenantFromRequest(pseudoReq);
}

/**
 * Minimal structural shape we need from Next.js's `ReadonlyHeaders`
 * (the type emitted by `await headers()` in server components). Kept
 * inline so this lib file doesn't depend on `next/server` types.
 */
interface ReadonlyHeaders {
  get(name: string): string | null;
  has(name: string): boolean;
  forEach(cb: (value: string, key: string) => void): void;
}

export function resolveTenantFromRequest(req?: Request): TenantContext {
  // T115t — test-only header override. Gate triple-locked:
  // 1. Build-time: env.tenant.xHeaderEnabled is only TRUE when the
  // NODE_ENV != 'production' check at boot lets the flag through.
  // 2. Runtime: the flag must be explicitly set in .env.local.
  // 3. Request: the header must be present AND pass the same slug
  // validator the env path uses (`asTenantContext` re-validates).
  // Missing any of the 3 → fall through to env.tenant.slug.
  if (req && env.tenant.xHeaderEnabled) {
    const headerSlug = req.headers.get(X_TENANT_HEADER);
    if (headerSlug && headerSlug.length > 0) {
      // asTenantContext throws on invalid slug — that's the right
      // behaviour: a test harness passing a malformed header should
      // surface loudly in the route handler rather than silently
      // fall through to the deployed tenant.
      return asTenantContext(headerSlug);
    }
  }
  // `asTenantContext` re-validates the slug at the trust boundary. The
  // env validator already checked it at boot, so this call will never
  // throw in practice — it's defence in depth against a stale cached
  // env object or an accidental hot-patch.
  return asTenantContext(env.tenant.slug);
}
