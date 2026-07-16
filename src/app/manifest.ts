import type { MetadataRoute } from 'next';

/**
 * PWA Web App Manifest (Next.js file convention).
 *
 * Next serves this at `/manifest.webmanifest` and injects
 * `<link rel="manifest">` into every page automatically — no change to
 * `layout.tsx` needed for the link itself.
 *
 * The member portal is the installable surface (it already ships a mobile
 * bottom-tab bar + `viewport-fit=cover`), so `start_url` points there.
 * `scope: '/'` keeps any auth redirect (e.g. → `/portal/sign-in`) inside the
 * installed app rather than kicking the user out to the browser.
 *
 * Icons reference the brand tiles in `public/` (generated from the traced
 * crown artwork `public/brand/tscc-mark.svg`):
 *   - `any`      → the TSCC crown mark on a rounded WHITE tile. White is
 *     load-bearing: the artwork's flag blue (#20419A) is 1.02:1 against the
 *     brand navy and would vanish on a navy tile.
 *   - `maskable` → a full-bleed white square with the mark inside the
 *     central safe zone, so Android can crop it to a circle/squircle without
 *     clipping the crowns.
 *
 * Splash/status-bar colours stay pinned to the brand navy.
 */
const tenantName = process.env.NEXT_PUBLIC_TENANT_NAME ?? 'SweCham';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/portal',
    name: `${tenantName} — Thai–Swedish Chamber of Commerce`,
    short_name: tenantName,
    description:
      'Membership portal for the Thailand–Swedish Chamber of Commerce — invoices, benefits, events and renewals.',
    start_url: '/portal',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'en',
    dir: 'ltr',
    background_color: '#0b2a4a',
    theme_color: '#0b2a4a',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/icon-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
