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
  // Security headers (HSTS, CSP, X-Frame-Options) are set in middleware.ts so
  // they apply uniformly to API routes and pages — single source of truth.
  experimental: {
    // Enterprise UX § 2.1 — skeleton shimmer relies on CSS animations;
    // no additional experimental flags needed for the MVP.
  },
};

export default withNextIntl(nextConfig);
