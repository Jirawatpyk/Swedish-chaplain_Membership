import type { NextConfig } from 'next';
import bundleAnalyzer from '@next/bundle-analyzer';
import createNextIntlPlugin from 'next-intl/plugin';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// F7 — bundle-budget enforcement (perf.md CHK038). Wrapper is a no-op
// when `ANALYZE !== 'true'`; the production build path is unaffected.
//
// Caveat: `@next/bundle-analyzer` is a webpack plugin. The current
// `pnpm build:analyse` script keeps `--turbopack` for parity with
// `pnpm build`, so the wrapper will not emit HTML reports while
// Turbopack is the active bundler. To actually generate the
// `<distDir>/analyze/{client,edge,nodejs}.html` artefacts, run with
// the webpack bundler explicitly:
//
//   ANALYZE=true pnpm next build           # no --turbopack flag
//
// Tracked for follow-up at Phase 3 polish (T117+) when
// virtualization budgets need empirical verification.
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the Turbopack workspace root to this project. Without this, Next.js
  // searches upward for a lockfile and can pick up an unrelated one (e.g.,
  // ~/package-lock.json) on Windows.
  turbopack: {
    root: projectRoot,
  },
  // F7 — Vercel serverless runtime (Node 22) does NOT enable
  // --experimental-require-module by default, so isomorphic-dompurify's
  // jsdom transitive chain (jsdom → html-encoding-sniffer → @exodus/bytes,
  // ESM-only) crashes Lambda cold-start with ERR_REQUIRE_ESM. Marking
  // them as server-side externals lets Node load them at runtime via the
  // pnpm.overrides-pinned CJS-clean versions instead of bundling them.
  // See docs/runbooks/f7-dompurify-esm-workaround.md.
  serverExternalPackages: [
    'isomorphic-dompurify',
    'jsdom',
    'html-encoding-sniffer',
    '@exodus/bytes',
  ],
  // Security headers (HSTS, CSP, X-Frame-Options) are set in proxy.ts so
  // they apply uniformly to API routes and pages — single source of truth.
  // (Next.js 16 renamed the `middleware.ts` convention to `proxy.ts`.)
  // 308 (permanent, method-preserving) redirects for relocated UI
  // routes — preserves any admin bookmarks + external links pointing
  // at the legacy location. Next.js 16's `permanent: true` emits 308
  // (NOT 301) intentionally — 301 historically allowed method changes
  // on retry which 308 does not. Behaviour for GET requests is
  // identical between the two from a browser perspective.
  async redirects() {
    return [
      {
        // F8 schedule editor moved from feature-nested to centralized
        // settings IA (sister of /admin/settings/invoicing). API routes
        // at /api/admin/renewals/* intentionally stayed put.
        source: '/admin/renewals/settings/schedules',
        destination: '/admin/settings/renewals/schedules',
        permanent: true,
      },
    ];
  },
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

export default withBundleAnalyzer(withNextIntl(nextConfig));
