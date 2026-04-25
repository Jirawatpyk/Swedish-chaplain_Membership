import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the Turbopack workspace root to this project. Without this, Next.js
  // searches upward for a lockfile and can pick up an unrelated one (e.g.,
  // ~/package-lock.json) on Windows.
  turbopack: {
    root: projectRoot,
  },
  // Security headers (HSTS, CSP, X-Frame-Options) are set in proxy.ts so
  // they apply uniformly to API routes and pages — single source of truth.
  // (Next.js 16 renamed the `middleware.ts` convention to `proxy.ts`.)
  experimental: {
    // Enterprise UX § 2.1 — skeleton shimmer relies on CSS animations.
    //
    // Audit 2026-04-26 round-2 #4 REVERTED via self-review #R2-A3:
    // attempted `cacheComponents: true` + `'use cache'` directive
    // migration. Two blockers surfaced:
    //   1. `cacheTag()` requires top-level `cacheComponents: true`
    //      (NOT just `experimental.useCache`) — that flag enables
    //      Partial Prerendering across the WHOLE app, which would
    //      need a separate audit pass on F1/F2/F3/F4 routes for PPR
    //      compatibility (Suspense boundaries, dynamic bailouts).
    //   2. `'use cache'` directive functions are inert outside the
    //      Next.js request runtime — vitest cannot unit-test them
    //      ("cacheTag() is only available with the cacheComponents
    //      config"). Production callers are all inside request
    //      handlers so they would work, but we lose test coverage.
    //
    // Decision: keep `unstable_cache` (works + testable + zero
    // blast on F1–F4). Re-evaluate during F11 SaaS Billing when the
    // multi-tenant cache strategy is re-designed holistically.
  },
};

export default withNextIntl(nextConfig);
