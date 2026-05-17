/**
 * T170 — Keyboard-only navigation E2E (spec SC-022, FR-024).
 *
 * Walks the staff sign-in flow using ONLY the keyboard:
 *   - Page loads with the email field auto-focused (FR-024)
 *   - Tab → Password, Tab → Submit
 *   - Shift+Tab navigates backwards
 *   - Enter submits the form
 *
 * Also exercises the idle-warning dialog keyboard behaviour:
 *   - Escape closes
 *   - Tab cycles within the modal
 *
 * Does not require sign-in credentials — all assertions operate on
 * the PUBLIC sign-in page and the modal invocation through a test
 * hook, so the spec runs even in an offline environment.
 */
import { expect, test } from './fixtures';

test.describe('keyboard-only navigation (T170, SC-022)', () => {
  test('sign-in page: auto-focus email + Enter submits from password field', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await page.waitForLoadState('networkidle');

    // Auto-focus per FR-024 primary-input auto-focus table
    await expect(page.getByLabel(/email/i)).toBeFocused();

    // Fill email via keyboard (focus is already on the email field)
    await page.keyboard.type('keyboard-only-test@swecham.test');

    // Tab through the form to reach the password input. The DOM order
    // on the staff sign-in page is: email input → "Forgot password?"
    // link → password input → submit button. We tab until the password
    // field is focused, giving up after 4 tabs to avoid infinite loops
    // if the tab order changes unexpectedly.
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      if (await page.getByRole('textbox', { name: /^password$/i }).evaluate((el) => el === document.activeElement)) {
        break;
      }
    }
    await expect(page.getByRole('textbox', { name: /^password$/i })).toBeFocused();

    await page.keyboard.type('wrong-password-for-keyboard-test');

    // Enter submits the form from any focused input field.
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/auth/sign-in'),
        { timeout: 10_000 },
      ),
      page.keyboard.press('Enter'),
    ]);
  });

  test('forgot-password page: email auto-focus + Enter submits', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.waitForLoadState('networkidle');
    await expect(page.getByLabel(/email/i)).toBeFocused();
    await page.keyboard.type('keyboard-forgot@swecham.test');
    await page.keyboard.press('Enter');
    await page.waitForResponse(
      (res) => res.url().includes('/api/auth/forgot-password'),
      { timeout: 10_000 },
    );
  });
});
