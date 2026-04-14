/**
 * T097 — E2E: /admin/plans/new wizard + /admin/plans/clone flow (US2).
 *
 * Covers:
 *   1. 4-step wizard (Basics → Fees → Benefits → Review) completes,
 *      submits, creates a new plan, and the new row appears in the list.
 *   2. "Clone 2026 → 2027" button invokes the clone dialog, confirms,
 *      and 9 new 2027 rows appear.
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

test.describe('plans create + clone wizard — US2', () => {
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

  test('admin creates a new plan via the 4-step wizard', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans/new');

    // Step 1 — Basics
    await expect(page.getByRole('heading', { name: /basics/i })).toBeVisible();
    const planId = `e2e-${Date.now().toString(36)}`;
    await page.getByLabel(/plan id/i).fill(planId);
    await page.getByLabel(/plan year/i).fill('2027');
    await page.getByLabel(/plan name \(en\)/i).fill('E2E Test Plan');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 2 — Fees
    await expect(page.getByRole('heading', { name: /fees/i })).toBeVisible();
    await page.getByLabel(/annual fee/i).fill('5000');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 3 — Benefits
    await expect(page.getByRole('heading', { name: 'Benefits', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 4 — Review
    await expect(page.getByRole('heading', { name: /review/i })).toBeVisible();
    await expect(page.getByText('E2E Test Plan')).toBeVisible();
    await page.getByRole('button', { name: /save|create/i }).click();

    // Verify redirect + row in list
    await page.waitForURL(/\/admin\/plans/, { timeout: 10_000 });
    await expect(page.getByText('E2E Test Plan')).toBeVisible();
  });

  test('admin clones 2026 → 2027 via the clone dialog', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans/clone');

    // Pick a unique target year per run so re-runs don't hit
    // 409 target_year_populated. Range 2030-2099 gives plenty of room.
    const TARGET_YEAR = String(2030 + (Date.now() % 70));

    await page.getByLabel(/source year/i).fill('2026');
    await page.getByLabel(/target year/i).fill(TARGET_YEAR);

    // Open confirmation dialog — use the page-level submit button,
    // not any "Clone year" nav link
    await page.getByRole('button', { name: /^clone\s+\d+\s+plans?$/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    // Click the confirmation button + wait for the POST in parallel
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/plans/clone') && r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page
        .getByRole('alertdialog')
        .getByRole('button', { name: /^clone\s+\d+\s+plans?$/i })
        .click(),
    ]);
    expect(response.status()).toBe(201);

    // Verify 9 new rows in the target-year filter
    await page.goto(`/admin/plans?year=${TARGET_YEAR}`);
    const rows = page.locator('tr[data-plan-id]');
    await expect(rows).toHaveCount(9, { timeout: 10_000 });
  });
});
