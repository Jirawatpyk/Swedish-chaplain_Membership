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
