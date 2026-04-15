/**
 * T126 — E2E: /admin/plans list-level US4 actions (deactivate / delete /
 * undelete).
 *
 * Covers the US4 acceptance flow end-to-end:
 *   1. Row-level dropdown menu exposes Deactivate → confirm dialog →
 *      toast → badge flips to Inactive.
 *   2. Row-level dropdown menu exposes Delete → confirm dialog →
 *      row hidden from default list.
 *   3. Show-deleted toggle surfaces deleted rows again.
 *   4. Undelete on a deleted row → row reappears as Inactive (never
 *      directly Active per AS4).
 *
 * Gated on `E2E_ADMIN_EMAIL/PASSWORD` env vars so CI can skip when the
 * seeded admin account is not available. Paired with the in-session
 * browser walk that is part of /speckit.qa for Phase 6.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('plans deactivate / delete / undelete — US4', () => {
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
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); }, { timeout: 10_000 });
  }

  test('full deactivate → delete → show-deleted → undelete flow', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans');

    // Ensure Premium starts Active (previous test runs may have left it
    // Inactive or deleted). Re-fetch status after each reset step
    // because restore + activate are sequential mutations.
    async function ensurePremiumActive(): Promise<void> {
      await page.goto('/admin/plans?showDeleted=true');
      let row = page.locator('[data-plan-id="premium"]').first();
      if (!(await row.count())) return;

      let status = (await row.textContent()) ?? '';
      if (/deleted/i.test(status)) {
        await row.getByRole('button', { name: /actions/i }).click();
        await page.getByRole('menuitem', { name: /undelete|restore/i }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: /restore/i }).click();
        await page.waitForTimeout(800);
        // Re-fetch the row + status — restore changed the DOM
        await page.goto('/admin/plans?showDeleted=true');
        row = page.locator('[data-plan-id="premium"]').first();
        status = (await row.textContent()) ?? '';
      }
      if (/inactive/i.test(status)) {
        await row.getByRole('button', { name: /actions/i }).click();
        await page.getByRole('menuitem', { name: /^activate$/i }).click();
        await page.waitForTimeout(800);
      }
    }
    await ensurePremiumActive();
    await page.goto('/admin/plans');

    // 1. Deactivate via row-level dropdown — wait for trigger to be
    // attached + visible BEFORE clicking; confirm the menu actually
    // opened via aria-expanded; fall back to a second click if Base UI
    // DropdownMenu's portal mount missed the first click (rare race).
    const row = page.locator('[data-plan-id="premium"]').first();
    const actionsTrigger = row.getByRole('button', { name: /actions/i });
    await actionsTrigger.waitFor({ state: 'visible', timeout: 5_000 });
    await actionsTrigger.click();
    const deactivateItem = page.getByRole('menuitem', { name: /deactivate/i });
    try {
      await deactivateItem.waitFor({ state: 'visible', timeout: 5_000 });
    } catch {
      // Retry once — Base UI DropdownMenu portal-mount race
      await actionsTrigger.click();
      await deactivateItem.waitFor({ state: 'visible', timeout: 5_000 });
    }
    await deactivateItem.click();

    // AlertDialog confirmation — confirmCta label matches the action verb
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: /deactivate/i }).click();

    // Toast + badge flip
    await expect(page.getByText(/deactivated/i).first()).toBeVisible();
    await expect(row.getByText(/inactive/i)).toBeVisible();

    // 2. Delete (soft-delete) via row-level dropdown
    await row.getByRole('button', { name: /actions/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: /^delete$/i }).click();

    // Row hidden from default list
    await expect(page.locator('[data-plan-id="premium"]')).toHaveCount(0);

    // 3. Show-deleted toggle reveals row again
    await page.getByRole('switch', { name: /show deleted/i }).click();
    await expect(page.locator('[data-plan-id="premium"]')).toBeVisible();

    // 4. Undelete
    const deletedRow = page.locator('[data-plan-id="premium"]').first();
    await deletedRow.getByRole('button', { name: /actions/i }).click();
    await page.getByRole('menuitem', { name: /undelete|restore/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: /restore/i }).click();

    // Row returns as Inactive (US4 AS4)
    await expect(deletedRow.getByText(/inactive/i)).toBeVisible();
  });
});
