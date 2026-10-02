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
  // Per-test budget. This file used to set none, so it was Playwright's 30 s
  // default, and a sweep of all 821 tests (2026-10-02, 14 sequential chunks)
  // showed that is too tight for this suite UNDER LOAD. Three reds came back at
  // 30.2-30.4 s — the signature of being killed at the ceiling rather than
  // failing an assertion — and all three pass on a quiet machine in 16.7 s,
  // 24.1 s and 26.8 s: `membership-suspension`'s never-block walk (and the gate
  // it guards is fine), `layout-responsive`'s page x viewport matrix, and
  // `admin-review-queue` AS2. So what this buys is not absolute headroom; it is
  // the removal of a coin-flip that only appears when the machine is busy. A
  // further 14 tests already PASS between 28 s and the old ceiling, which is the
  // queue of tests that would have flipped next.
  //
  // Raising a timeout cannot make a broken test pass — a timeout is not an
  // assertion — it only stops a slow-but-correct test being killed. The cost is
  // that a test which hangs for a real reason takes 60 s to say so instead of
  // 30 s. No such test is known in this suite today: the one that looked like a
  // hang (`renewals/pipeline-mobile-cards`' last-card check, 30 s killed then
  // 61.6 s killed) passes on its own in 5.4 s, so the longer ceiling delayed a
  // contention flake's report rather than exposing a defect.
  //
  // Which is the pattern behind all of this. Six tests are now known to fail
  // only inside a multi-spec run and pass alone: those two pipeline tests,
  // `admin-review-queue`, `layout-responsive`, `payment-resume-on-reopen` and
  // `rbac-navigation`. A 14-chunk sweep sharing one machine with the dev server
  // and one Neon branch is the condition, not the pages.
  //
  // Specs needing more still set their own (`test.slow()`, or a
  // `describe.configure({ timeout })`), and those stay as they are.
  timeout: 60_000,
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
