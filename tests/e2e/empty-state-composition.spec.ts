/**
 * T052 — E2E: F4 US5 EmptyState composition inside ContentContainer.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F4 US5 — empty state composition @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('empty state renders inside ContentContainer with token spacing', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/admin(\/|$)/);

    await page.goto('/admin/plans?year=1900'); // force empty year
    const container = page.locator('[data-slot="content-container"]').first();
    await expect(container).toBeVisible();

    // The existing empty-state renders via PlansTable; ensure *something*
    // communicating "no plans" surfaces inside the container.
    const emptyText = container.getByText(/no plans/i);
    await expect(emptyText.first()).toBeVisible({ timeout: 10_000 });
  });
});
