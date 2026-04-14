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

    // 1. Deactivate via row-level dropdown
    const row = page.locator('[data-plan-id="premium"]').first();
    await row.getByRole('button', { name: /actions/i }).click();
    await page.getByRole('menuitem', { name: /deactivate/i }).click();

    // AlertDialog confirmation
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: /confirm/i }).click();

    // Toast + badge flip
    await expect(page.getByText(/deactivated/i)).toBeVisible();
    await expect(row.getByText(/inactive/i)).toBeVisible();

    // 2. Delete (soft-delete) via row-level dropdown
    await row.getByRole('button', { name: /actions/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: /confirm/i }).click();

    // Row hidden from default list
    await expect(page.locator('[data-plan-id="premium"]')).toHaveCount(0);

    // 3. Show-deleted toggle reveals row again
    await page.getByRole('switch', { name: /show deleted/i }).click();
    await expect(page.locator('[data-plan-id="premium"]')).toBeVisible();

    // 4. Undelete
    const deletedRow = page.locator('[data-plan-id="premium"]').first();
    await deletedRow.getByRole('button', { name: /actions/i }).click();
    await page.getByRole('menuitem', { name: /undelete/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: /confirm/i }).click();

    // Row returns as Inactive (US4 AS4)
    await expect(deletedRow.getByText(/inactive/i)).toBeVisible();
  });
});
