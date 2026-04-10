/**
 * Change-password page a11y axe scan (spec FR-024, WCAG 2.1 AA).
 *
 * F1 Review Gate checklist: every authenticated self-service screen
 * gets an axe scan. This spec signs in as the seeded E2E admin,
 * navigates to `/admin/account`, and scans the change-password form
 * with @axe-core/playwright.
 *
 * Does NOT submit the form — a separate E2E (`change-password.spec.ts`)
 * owns the happy-path mutation. This spec only asserts that the
 * rendered DOM is accessible.
 *
 * Skips if the E2E admin isn't seeded (see scripts/seed-e2e-user.ts).
 */
import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const E2E_ADMIN_EMAIL = 'e2e-admin@swecham.test';
const E2E_ADMIN_PASSWORD = 'E2E-Testing-Password-2026!xZ';

test.describe('change-password page a11y (WCAG 2.1 AA)', () => {
  test('signed-in /admin/account has no serious axe violations', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(E2E_ADMIN_EMAIL);
    await page.getByLabel(/password/i).fill(E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    await page.goto('/admin/account');
    await page.waitForLoadState('networkidle');
    // The current-password field is auto-focused per ux-standards § 8;
    // wait for it so axe scans a settled DOM.
    await expect(page.getByLabel(/current password/i)).toBeVisible();

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const serious = result.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    if (serious.length > 0) {
      console.log(
        `  axe violations on /admin/account: ${serious
          .map((v) => `${v.id}(${v.impact})`)
          .join(', ')}`,
      );
    }
    expect(serious).toHaveLength(0);
  });
});
