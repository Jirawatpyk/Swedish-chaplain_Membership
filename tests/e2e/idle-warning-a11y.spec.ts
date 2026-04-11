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
import { expect, fillField, test } from './fixtures';
import AxeBuilder from '@axe-core/playwright';

const E2E_ADMIN_EMAIL = 'e2e-admin@swecham.test';
const E2E_ADMIN_PASSWORD = 'E2E-Testing-Password-2026!xZ';

test.describe('idle-warning dialog a11y (WCAG 2.1 AA)', () => {
  test('idle-warning alertdialog has no serious axe violations while open', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), E2E_ADMIN_EMAIL);
    await fillField(page.getByLabel(/password/i), E2E_ADMIN_PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    // The idle-warning dialog component attaches its
    // `swecham:open-idle-warning` listener inside a `useEffect`, so
    // it's only ready AFTER the component has mounted on the page.
    // On webkit the mount can race the first `dispatchEvent`, so
    // we retry the dispatch until the dialog opens (or 5 s elapse).
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'));
    await expect
      .poll(
        async () => {
          await page.evaluate(() => {
            window.dispatchEvent(new CustomEvent('swecham:open-idle-warning'));
          });
          return dialog.first().isVisible();
        },
        {
          message: 'idle-warning dialog did not open after dispatching swecham:open-idle-warning',
          timeout: 5_000,
          intervals: [250, 500, 1_000],
        },
      )
      .toBe(true);

    // Exclude Base UI's internal focus-guard spans from the scan.
    // Base UI inserts invisible `<span role="button"
    // data-base-ui-focus-guard>` elements as focus-trap sentinels
    // around `AlertDialog`. axe flags them under
    // `aria-command-name` because they have `role="button"` without
    // an accessible name. They are **intentionally invisible**
    // (clip-path inset(50%), 1×1 px) and **not user-interactive** —
    // they exist purely to redirect Tab/Shift-Tab inside the modal.
    // This is a library concern tracked upstream; excluding them
    // here keeps the scan focused on OUR content.
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .exclude('[data-base-ui-focus-guard]')
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
