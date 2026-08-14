/**
 * T120 — Destructive-action confirmation dialog E2E
 * (spec FR-024, ux-standards § 6).
 *
 * Every destructive action in the admin UI MUST present a
 * ConfirmationDialog (disable/enable/role-change on /admin/users).
 * The dialog:
 *   - Has "Cancel" focused by default (safer default).
 *   - Closes on Escape.
 *   - Only fires the mutation when "Confirm" is explicitly clicked.
 *
 * Skips without admin credentials. Operates on the /admin/users page
 * by clicking the first action button and asserting the dialog
 * appears + Cancel dismisses it without firing the API.
 */
import { expect, fillField, test } from './fixtures';

// Super admin since 016 D4: the destructive buttons under test live on
// /admin/users, which is `users.manage` = super_admin-only (a plain admin
// now 404s there).
const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;

test.describe('destructive-action confirmation (T120)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_SUPER_ADMIN_EMAIL and E2E_SUPER_ADMIN_PASSWORD to run',
  );

  test('disable/enable opens ConfirmationDialog and Cancel dismisses it', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    await page.goto('/admin/users');
    await page.waitForLoadState('networkidle');

    // Find the first CONFIRMATION-pattern destructive button (disable /
    // enable). "Change role" is deliberately EXCLUDED: since 016 it opens
    // ChangeRoleDialog, a picker whose focus contract intentionally deviates
    // from §6.4 (focus lands in the RadioGroup, NOT on Cancel — 016 UX
    // review I1), and it renders FIRST in a super_admin's row cluster, so
    // matching it here asserted the wrong dialog's contract. Its own focus
    // behaviour is pinned by the T046 persona spec.
    const destructiveBtn = page
      .getByRole('button', { name: /disable|enable/i })
      .first();
    if ((await destructiveBtn.count()) === 0) {
      test.skip(
        true,
        'No destructive actions visible — users table may be empty',
      );
      return;
    }

    // Track any API call to the mutation endpoints; failing-loud if a
    // request fires before we explicitly confirm would prove the
    // dialog is a decoration, not a gate.
    let mutationFired = false;
    page.on('request', (req) => {
      const url = req.url();
      if (
        req.method() === 'POST' &&
        (url.includes('/disable') ||
          url.includes('/enable') ||
          url.includes('/role'))
      ) {
        mutationFired = true;
      }
    });

    await destructiveBtn.click();

    // Dialog should be visible and Cancel should have focus.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    const cancel = dialog.getByRole('button', { name: /cancel/i });
    await expect(cancel).toBeFocused();

    // Escape closes the dialog without firing the mutation.
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    expect(mutationFired).toBe(false);
  });
});
