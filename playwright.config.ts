import { readFileSync, existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Minimal `.env.local` loader (no dotenv dep).
 *
 * Playwright does NOT auto-load .env files, so the global-setup +
 * test workers lose access to Upstash and DB credentials unless we
 * inject them here. Parses `KEY=VALUE` lines, strips `export `
 * prefixes, removes surrounding single- or double-quotes, and
 * ignores existing process.env values so an operator can still
 * override locally via `UPSTASH_REDIS_REST_URL=... pnpm test:e2e`.
 */
function loadEnvLocal(): void {
  const path = '.env.local';
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!key || process.env[key] !== undefined) continue;
    let value = rawValue ?? '';
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnvLocal();

/**
 * Playwright configuration for F1 auth flows.
 *
 * Matrix:
 *   - Chromium desktop
 *   - Mobile Safari (iPhone 12)
 *   - Chrome Android (Pixel 5)
 *
 * a11y scans via @axe-core/playwright run inside individual specs
 * (tests/e2e/*-a11y.spec.ts) — no separate project needed.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Global setup clears Upstash rate-limit buckets so a prior run's
  // residue doesn't trip the 5/15-min sign-in limit. See
  // tests/e2e/global-setup.ts.
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retry flaky specs once locally, twice in CI. The E2E suite is
  // inherently race-prone because all specs share the same seeded
  // accounts and hit shared Upstash + Neon state; per-test
  // `autoClearRateLimits` (see tests/e2e/fixtures.ts) handles the
  // common case but transient timing issues around `waitForURL` on
  // admin sign-in still occur. Retries mask these cleanly — a real
  // regression fails on both attempts.
  retries: process.env.CI ? 2 : 2,
  // Workers: CI uses 1 (deterministic). Locally we cap at 3 workers
  // because the Turbopack dev server on port 3100 runs all compiles
  // on-demand — 6 concurrent workers hammering /admin/sign-in +
  // /portal/sign-in + /admin/account for the first time triggers
  // Turbopack cold-compile queues that take >45 s per route. Three
  // workers gives each Chromium/WebKit/Mobile-Chrome project its
  // own worker so specs run roughly in parallel across projects
  // but the dev server isn't swamped.
  workers: process.env.CI ? 1 : 3,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  use: {
    // Tests run against port 3100 (not the default 3000) so they don't
    // collide with any long-lived dev server the operator keeps on 3000.
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-safari',
      use: {
        ...devices['iPhone 12'],
        // WebKit emulation + Next.js dev-server cold compile = far
        // slower than Chromium for the first request to any route.
        // Production builds pre-compile chunks and don't need these
        // bumped budgets — these only matter for local dev e2e runs.
        actionTimeout: 90_000,
        navigationTimeout: 90_000,
      },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
    // F8 Phase 10 / T270 close — Cross-browser matrix expansion for
    // the spec'd "Chrome / Edge / Firefox / Safari latest 2 + Mobile
    // Safari iOS 16+ + Chrome for Android 12+" requirement. Default-
    // OFF to keep local + CI workflows fast (firefox + webkit each
    // ~3-5× slower to spin up than chromium-headless). Toggle on with
    // `CI_FULL_BROWSERS=1` in the cross-browser-matrix CI job OR
    // before a maintainer manual run pre-merge.
    //
    // Browser executables MUST be installed first:
    //   pnpm exec playwright install firefox webkit
    //
    // Edge uses the chromium engine — covered by the `chromium`
    // project above (Microsoft Edge ships Chromium under the hood
    // since 2020). Desktop-Safari is covered by `webkit`.
    ...(process.env.CI_FULL_BROWSERS === '1'
      ? [
          {
            name: 'firefox',
            use: { ...devices['Desktop Firefox'] },
          },
          {
            name: 'webkit',
            use: {
              ...devices['Desktop Safari'],
              // Same WebKit cold-compile budget as mobile-safari.
              actionTimeout: 90_000,
              navigationTimeout: 90_000,
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: 'pnpm dev --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // Enable /__test__/* fixture pages (button-matrix etc.) used by
      // E2E specs. The page itself refuses to render unless this env
      // var is set, so production deploys never expose the routes.
      ALLOW_TEST_ROUTES: '1',
    },
  },
});
