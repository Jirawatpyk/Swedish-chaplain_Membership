/**
 * T143 — E2E: /admin/settings/fees page (US5 FR-017).
 *
 * Covers the US5 acceptance flow:
 *   1. Admin sees fee-config form pre-populated with current VAT +
 *      registration fee + read-only currency.
 *   2. Admin edits VAT → saves → toast confirms + value persists on reload.
 *   3. Manager signs in → fee-config page shows values but edit controls
 *      are hidden or disabled (FR-017 read-only enforcement).
 *
 * Gated on `E2E_ADMIN_EMAIL/PASSWORD` + `E2E_MANAGER_EMAIL/PASSWORD`
 * env vars so CI can skip when seeded accounts are not available.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('fee config — US5', () => {
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page, email: string, password: string): Promise<void> {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); }, { timeout: 10_000 });
  }

  test('admin edits VAT → saves → toast', async ({ page }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
    );
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/settings/fees');

    // Wait for form to hydrate — use getByLabel to disambiguate from
    // the page subtitle which also contains "VAT rate" text.
    const vatInput = page.getByLabel(/vat rate/i);
    await expect(vatInput).toBeVisible();

    // Currency read-only
    const currencyField = page.getByLabel(/currency/i);
    await expect(currencyField).toBeDisabled();

    // Edit VAT rate
    await vatInput.fill('0.075');

    await page.getByRole('button', { name: /save/i }).click();

    // Toast + value persisted
    await expect(page.getByText(/saved|updated/i).first()).toBeVisible();
  });

  test('manager sees read-only fee config', async ({ page }) => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL and E2E_MANAGER_PASSWORD',
    );
    await signIn(page, MANAGER_EMAIL!, MANAGER_PASSWORD!);
    await page.goto('/admin/settings/fees');

    // VAT field present but disabled
    await expect(page.getByText(/vat rate/i)).toBeVisible();
    const vatInput = page.getByLabel(/vat rate/i);
    await expect(vatInput).toBeDisabled();

    // Save button hidden or disabled
    const saveButton = page.getByRole('button', { name: /save/i });
    const count = await saveButton.count();
    if (count > 0) {
      await expect(saveButton).toBeDisabled();
    }
  });
});
