/**
 * Shared Playwright test fixture that clears Upstash rate-limit
 * buckets BEFORE every test.
 *
 * Why this exists: the E2E suite shares 4 seeded accounts
 * (`e2e-admin`, `e2e-manager`, `e2e-member`, `e2e-lockout`) across
 * ~30 specs and 3 browser projects (chromium, mobile-chrome,
 * mobile-safari). Each project runs every spec in sequence, and
 * most specs sign in at least once. The per-email sign-in rate
 * limit is `5 attempts per 15 minutes` — across a full suite run
 * that budget is exhausted within minutes, cascading into
 * `waitForURL` timeouts and false failures.
 *
 * The `autoClearRateLimits` fixture below runs as an "auto"
 * Playwright fixture, meaning it fires before every test without
 * the spec having to opt in. Importing `test` from this file is
 * the only change each spec needs.
 *
 * Usage in a spec file:
 *
 *     import { expect, test } from './fixtures';   // not '@playwright/test'
 *     test('...', async ({ page }) => { ... });
 *
 * `expect` is re-exported from `@playwright/test` unchanged so
 * specs only need to swap one import line.
 */
import { test as base } from '@playwright/test';
import { clearE2ERateLimits } from './helpers/rate-limit';

export const test = base.extend<{ autoClearRateLimits: void }>({
  // `auto: true` makes this fixture run for every test in any
  // spec that imports `test` from this file. The implementation
  // calls `clearE2ERateLimits()` before the test, hands control
  // back via `use()`, and does nothing in teardown.
  autoClearRateLimits: [
    async ({}, use) => {
      await clearE2ERateLimits();
      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
