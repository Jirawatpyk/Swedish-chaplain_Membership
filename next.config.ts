import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Security headers are set in middleware.ts so they apply to API routes too.
  // Keep next.config minimal to avoid duplicate header sources.
  experimental: {
    // Enterprise UX § 2.1 — skeleton shimmer relies on CSS animations;
    // no additional experimental flags needed for the MVP.
  },
  // Turbopack is the default in Next.js 16; no separate config required
  // unless custom resolvers are introduced.
};

export default withNextIntl(nextConfig);
