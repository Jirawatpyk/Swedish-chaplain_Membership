/**
 * E2E — user-facing LocaleSwitcher (EN/TH/SV).
 *
 * @i18n
 *
 * Drives the REAL control (the other i18n specs seed the NEXT_LOCALE cookie
 * directly):
 *   1. Staff header  — EN→TH updates <html lang> + cookie, then back to EN.
 *   2. Auth page     — switch to TH before signing in (no session).
 *   3. Member portal — switcher stays visible at a 320px mobile width
 *      with no horizontal overflow.
 *
 * Gated on E2E_ADMIN_* / E2E_MEMBER_* env vars.
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

async function signIn(page: Page, email: string, password: string, portal: 'admin' | 'portal') {
  await page.goto(`/${portal}/sign-in`);
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  const base = portal === 'admin' ? '/admin' : '/portal';
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return p.startsWith(base) && !p.includes('/sign-in');
    },
    { timeout: 15_000 },
  );
}

// The trigger's accessible name is localized (sr-only label + endonym), so
// after a switch it is no longer English. Match ALL three label variants so
// the trigger re-lookup is locale-stable across a round-trip. Radio-item
// endonyms (localeLabels) are locale-stable, so `optionName` can stay exact.
const TRIGGER_NAME = /change language|เปลี่ยนภาษา|byt språk/i;

async function chooseLanguage(page: Page, optionName: RegExp) {
  await page.getByRole('button', { name: TRIGGER_NAME }).click();
  await page.getByRole('menuitemradio', { name: optionName }).click();
}

test.describe.configure({ mode: 'serial' });

test.describe('LocaleSwitcher @i18n', () => {
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('staff header switches EN↔TH and updates <html lang> + cookie', async ({ page, context }) => {
    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_EMAIL/PASSWORD');
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');

    await chooseLanguage(page, /^ไทย$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === 'NEXT_LOCALE')?.value).toBe('th');

    await chooseLanguage(page, /^English$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('auth page switches to Thai before sign-in (no session)', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await chooseLanguage(page, /^ไทย$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'th');
  });

  test('member portal keeps the switcher visible at 320px with no horizontal overflow', async ({ page }) => {
    test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL/PASSWORD');
    await page.setViewportSize({ width: 320, height: 780 });
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!, 'portal');
    await expect(page.getByRole('button', { name: TRIGGER_NAME })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
  });
});
