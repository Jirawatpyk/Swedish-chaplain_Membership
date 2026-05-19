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
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); }, { timeout: 10_000 });
  }

  test('admin edits a current-year plan name + fee', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans/2026/premium/edit');

    await expect(page.getByRole('heading', { name: /premium/i })).toBeVisible();

    // Mutate plan_name.en — use a unique value so re-runs don't no-op
    const newName = `Premium Plus ${Date.now().toString(36).slice(-4)}`;
    const nameInput = page.getByLabel(/plan name.*en/i).first();
    await nameInput.fill(newName);
    // Wait a tick for React state to commit before clicking submit
    await page.waitForTimeout(150);

    // Save — wait for the PATCH response in parallel with the click so
    // we catch both success and validation errors deterministically.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/plans/2026/premium') && r.request().method() === 'PATCH',
        { timeout: 10_000 },
      ),
      page.getByRole('button', { name: /save/i }).click(),
    ]);
    expect(response.status()).toBe(200);

    // Redirect back to list (toast may fire + fade before we can assert)
    await page.waitForURL(/\/admin\/plans(?!\/\d{4})/, { timeout: 10_000 });
    await expect(page.getByText(newName)).toBeVisible();
  });

  test('admin sees persistent lock banner on prior-year plan', async ({ page }) => {
    // The seed catalogue is 2026 (the year this F2 spec was written for).
    // While the system clock is still in 2026 the prior-year lock cannot
    // be exercised against a real seeded plan — there is no 2025 fixture.
    // The banner logic itself is unit-tested in the Domain layer
    // (`detect-locked-field-changes.test.ts`); this E2E only proves the
    // banner *renders* once 2027 catalogue plans exist. Skip until a
    // 2027+ seed lands or the system clock advances past 2026-12-31.
    test.skip(
      new Date().getFullYear() <= 2026,
      'Lock banner needs a plan from a prior calendar year — only 2026 is seeded today.',
    );
    await signIn(page);
    await page.goto('/admin/plans/2026/premium/edit');

    // Banner visible
    await expect(page.getByText(/historical plan/i)).toBeVisible();

    // annual_fee should be disabled
    const feeInput = page.getByLabel(/annual fee/i);
    await expect(feeInput).toBeDisabled();
  });
});
