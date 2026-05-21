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
import { test as base, type Locator, type Page } from '@playwright/test';
import { clearE2ERateLimits } from './helpers/rate-limit';

export const test = base.extend<{
  autoClearRateLimits: void;
  page: Page;
}>({
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

  /**
   * F7.1b B6 closure 2026-05-21 — capture client-side JavaScript
   * runtime errors. The default Playwright `page` fixture silently
   * ignores `pageerror` events (unhandled exceptions thrown in the
   * browser context), which means React hydration errors, unhandled
   * promise rejections, and other client bugs slip past every spec
   * unless the test happens to fail another assertion as a side
   * effect. This wrapper attaches a listener, accumulates errors,
   * surfaces them via `testInfo.attach`, AND fails the test when
   * any pageerror occurred — turning silent client breakage into a
   * loud, attributable failure.
   *
   * Opt-out via env: `E2E_PAGEERROR_IGNORE=true` keeps capture +
   * attachment but skips the auto-fail. Use sparingly (e.g. tests
   * that intentionally trigger client errors as part of UX flows
   * — Sentry-style debugging, malformed-input tests).
   */
  // The Playwright fixture callback parameter is conventionally named
  // `use` but we use `runTest` here to avoid the `react-hooks/rules-of-hooks`
  // lint rule (which mistakes Playwright's `use(value)` for React's
  // `use()` hook).
  page: async ({ page }, runTest, testInfo) => {
    const errors: Error[] = [];
    const handler = (error: Error): void => {
      errors.push(error);
    };
    page.on('pageerror', handler);
    try {
      await runTest(page);
    } finally {
      page.off('pageerror', handler);
      if (errors.length > 0) {
        await testInfo.attach('page-errors.txt', {
          body: errors
            .map((e, i) => `[${i + 1}] ${e.name}: ${e.message}\n${e.stack ?? '(no stack)'}`)
            .join('\n---\n'),
          contentType: 'text/plain',
        });
        if (process.env.E2E_PAGEERROR_IGNORE !== 'true') {
          throw new Error(
            `Captured ${errors.length} client-side pageerror(s); first: ${errors[0]!.message}`,
          );
        }
      }
    }
  },
});

export { expect } from '@playwright/test';

// --- Form input helpers ------------------------------------------------------
//
// Why this exists: WebKit (Playwright's mobile-safari project via
// iPhone 12 device emulation) has an input-event-sequence quirk
// where `locator.fill(value)` on a validated text input (e.g. an
// email field bound to react-hook-form) can end up with an empty
// field that IMMEDIATELY trips "Invalid email" validation. The
// same `.fill()` works correctly on chromium/mobile-chrome. The
// root cause appears to be that WebKit's input autofill layer
// swallows the programmatic value when the field has input
// type="email" + active form validation listeners.
//
// The fix: on WebKit, fall back to `pressSequentially(value)`
// which emits a real key event per character. The cost is ~50 ms
// for a typical password (vs ~5 ms for fill) — acceptable on a
// test-only path. On chromium/mobile-chrome we keep the fast
// `.fill()` path unchanged.
//
// All sign-in and form-input specs should use `fillField(...)`
// instead of `locator.fill(...)` directly.

/**
 * Resolve the engine name of the browser that owns this page.
 * Playwright's `browser()` returns the BrowserType which exposes
 * `.name()` → one of `'chromium' | 'firefox' | 'webkit'`. The
 * project name (e.g. `mobile-safari`) is opaque at this layer;
 * what matters for the fill quirk is the underlying engine.
 */
function browserEngine(page: Page): 'chromium' | 'firefox' | 'webkit' {
  const name = page.context().browser()?.browserType().name();
  if (name === 'webkit' || name === 'firefox' || name === 'chromium') {
    return name;
  }
  // Fall back conservatively — treat unknown as chromium (most
  // common) so the fast path is used.
  return 'chromium';
}

/**
 * Fill a form field reliably across all Playwright browser
 * engines. Uses the fast `.fill()` on chromium/firefox and the
 * keystroke-emitting `.pressSequentially()` on webkit to work
 * around the mobile-safari input quirk described above.
 *
 * Usage:
 *
 *     await fillField(page.getByLabel(/email/i), 'user@example.com');
 *     // Note: prefer `getByRole('textbox', { name: /^password$/i })`
 *     // over `getByLabel(/password/i)` — the F1 PasswordInput primitive
 *     // adds a "Show password" toggle <button> that the label-regex
 *     // also matches, causing strict-mode violations.
 *     await fillField(dialog.getByRole('textbox', { name: /^password$/i }), 'secret');
 *
 * Pass the locator directly — the helper needs it to find the
 * owning page for the engine detection.
 */
export async function fillField(
  locator: Locator,
  value: string,
): Promise<void> {
  const page = locator.page();
  const engine = browserEngine(page);

  if (engine === 'webkit') {
    // Focus + clear + keystroke. The clear step is defensive:
    // if the field already has a previous value (rare in E2E but
    // possible on retry), `pressSequentially` would append to it.
    await locator.click();
    await locator.clear();
    await locator.pressSequentially(value, { delay: 10 });
  } else {
    await locator.fill(value);
  }
}
