/**
 * Shared helpers for F5 layout-container E2E specs.
 *
 * Keeps the specs in tests/e2e/layout/ DRY and gives a single point of
 * maintenance for sign-in, overflow checks, container-ready waits, and
 * dynamic fixture resolution.
 */
import { expect, type Page } from '@playwright/test';
import { fillField } from '../fixtures';
import { signInLandingSettled } from './sign-in-landing';

/**
 * Sign in at the given form path using email + password, then wait
 * until the browser lands anywhere under `landingPattern` other than
 * the sign-in path itself.
 *
 * Uses `fillField` from the shared test fixtures so sign-ins work
 * correctly on `mobile-safari` (WebKit has an input-event quirk that
 * empties validated email fields when using `.fill()` directly — see
 * `tests/e2e/fixtures.ts` for the workaround).
 *
 * Excluding the sign-in path from the landing match prevents the regex
 * from resolving pre-redirect (e.g. `/^\/admin(\/|$)/` matches
 * `/admin/sign-in` too) and letting downstream `page.goto` calls race
 * the auth handshake.
 */
export async function signInViaForm(
  page: Page,
  signInPath: string,
  email: string,
  password: string,
  landingPattern: RegExp,
): Promise<void> {
  await page.goto(signInPath);
  await fillField(page.getByLabel(/email/i), email);
  // R9.B1 / F1 PasswordInput regression — see admin-session.ts:27.
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  // See sign-in-landing.ts — WebKit fails the next goto without this.
  const landingSettled = signInLandingSettled(page, signInPath);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => {
    const p = new URL(u).pathname;
    return landingPattern.test(p) && !p.startsWith(signInPath);
  });
  await landingSettled;
}

/**
 * Assert the document does not horizontally overflow the viewport.
 * SC-005 contract.
 *
 * `scrollWidth <= clientWidth`, not `=== clientWidth`. `globals.css` sets
 * `html { scrollbar-gutter: stable }` (F8 #24, 2026-05-11), so the browser
 * reserves the scrollbar column permanently and the document is ~15 px
 * NARROWER than the viewport: 1425 against 1440 at 1440 px, measured the same
 * on both sides of the AURA shell migration. The equality form therefore could
 * not hold on any viewport where the gutter applies, and failed with
 * "must not horizontally overflow" while reporting an UNDER-wide document —
 * 17 failures in the 2026-09-26 full-suite run, read at first as an AURA
 * regression. Overflow is what this guards; a narrower document is the gutter
 * doing its job.
 */
export async function assertNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    scrollWidth,
    'body must not horizontally overflow the viewport',
  ).toBeLessThanOrEqual(clientWidth);
}

/**
 * Wait for the real (non-skeleton) layout container to paint. Use this
 * before counting containers or measuring widths — `networkidle` alone
 * is unreliable on streamed server-components pages and can resolve
 * while the skeleton is still mounted.
 */
export async function waitForLayoutContainer(
  page: Page,
  timeoutMs = 15_000,
): Promise<void> {
  await page
    .locator('[data-slot="layout-container"]')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs });
  await page.waitForLoadState('networkidle');
}

/**
 * Navigate to the admin members directory filtered to active rows and
 * return the first member's UUID. Used by breadth sweeps that want to
 * exercise `[memberId]` routes without a hard-coded env var.
 *
 * Asserts the directory actually loaded (vs. a silent auth redirect)
 * before reading the row, so failure messages self-diagnose.
 *
 * Throws if the directory is empty — callers should skip upstream when
 * seed data is not available.
 */
export async function firstActiveMemberId(page: Page): Promise<string> {
  await page.goto('/admin/members?status=active');
  await page.waitForLoadState('networkidle');
  await expect(
    page,
    'firstActiveMemberId: expected /admin/members — sign-in may have failed silently',
  ).toHaveURL(/\/admin\/members/);
  const firstRow = page.locator('table tbody tr').first();
  await firstRow.waitFor({ timeout: 15_000 });
  const href = await firstRow.locator('a').first().getAttribute('href');
  if (!href) throw new Error('No active member rows — seed required');
  const match = href.match(/\/admin\/members\/([0-9a-f-]+)/);
  if (!match) throw new Error(`Could not parse memberId from ${href}`);
  return match[1]!;
}
