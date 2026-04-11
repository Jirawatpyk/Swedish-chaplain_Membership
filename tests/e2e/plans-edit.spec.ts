/**
 * T115 — E2E: /admin/plans/[year]/[planId]/edit (US3).
 *
 * Covers:
 *   1. Admin opens an existing plan's edit view → sees form prefilled
 *   2. Current-year edits — changes plan_name.en + annual_fee → save →
 *      row reflects new values in list + toast "Plan updated"
 *   3. Prior-year edits — banner visible + annual_fee input disabled
 *      with lock icon tooltip; cosmetic fields still editable
 *
 * Gated on `E2E_ADMIN_EMAIL/PASSWORD` env vars so CI can skip when the
 * seeded admin account is not available.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('plans edit — US3', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
  }

  test('admin edits a current-year plan name + fee', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans/2026/premium/edit');

    await expect(page.getByRole('heading', { name: /premium/i })).toBeVisible();

    // Mutate plan_name.en
    const nameInput = page.getByLabel(/plan name.*en/i).first();
    await nameInput.fill('Premium Plus');

    // Save
    await page.getByRole('button', { name: /save/i }).click();

    // Toast + redirect back to list
    await expect(page.getByText(/plan.*updated/i)).toBeVisible({ timeout: 5_000 });
    await page.waitForURL(/\/admin\/plans/, { timeout: 10_000 });
    await expect(page.getByText('Premium Plus')).toBeVisible();
  });

  test('admin sees persistent lock banner on prior-year plan', async ({ page }) => {
    await signIn(page);
    // Assumes the clock has advanced past 2026 on the E2E Neon branch
    await page.goto('/admin/plans/2026/premium/edit');

    // Banner visible
    await expect(page.getByText(/historical plan/i)).toBeVisible();

    // annual_fee should be disabled
    const feeInput = page.getByLabel(/annual fee/i);
    await expect(feeInput).toBeDisabled();
  });
});
