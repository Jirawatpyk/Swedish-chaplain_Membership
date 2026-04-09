import { defineConfig, devices } from '@playwright/test';

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
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
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
      use: { ...devices['iPhone 12'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: 'pnpm dev --port 3100',
    url: 'http://localhost:3100',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
