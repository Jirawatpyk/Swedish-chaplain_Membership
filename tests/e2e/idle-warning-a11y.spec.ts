/**
 * Idle-warning dialog a11y axe scan (spec FR-022, WCAG 2.1 AA).
 *
 * The idle-warning dialog opens when the session approaches its
 * idle cap (30 min by default). Simulating 30 min of inactivity
 * inside an E2E run is unreasonable, so this spec dispatches the
 * `swecham:open-idle-warning` custom event that the dialog component
 * listens for — an intentional hook left in the code path for this
 * exact use case.
 *
 * Scan scope: the dialog itself (role=alertdialog) + surrounding page
 * so we catch contrast / focus-trap / landmark violations that only
 * appear while the dialog is open.
 */
import { expect, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const E2E_ADMIN_EMAIL = 'e2e-admin@swecham.test';
const E2E_ADMIN_PASSWORD = 'E2E-Testing-Password-2026!xZ';

test.describe('idle-warning dialog a11y (WCAG 2.1 AA)', () => {
  test('idle-warning alertdialog has no serious axe violations while open', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(E2E_ADMIN_EMAIL);
    await page.getByLabel(/password/i).fill(E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    // Trigger the idle warning via the component's test hook. If the
    // hook isn't present (component was rewritten without it), the
    // evaluate call is a no-op and the assertion below will fail with
    // a clear message instead of hanging.
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('swecham:open-idle-warning'));
    });

    // The dialog might take a frame to paint — wait for its ARIA role.
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect(dialog.first()).toBeVisible({ timeout: 5_000 });

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const serious = result.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    if (serious.length > 0) {
      console.log(
        `  axe violations on idle-warning dialog: ${serious
          .map((v) => `${v.id}(${v.impact})`)
          .join(', ')}`,
      );
    }
    expect(serious).toHaveLength(0);
  });
});
