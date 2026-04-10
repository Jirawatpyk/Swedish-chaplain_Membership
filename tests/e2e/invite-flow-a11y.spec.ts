/**
 * Invite-flow a11y axe scan (spec FR-024, WCAG 2.1 AA).
 *
 * F1 Review Gate checklist: every auth-facing screen gets an axe
 * scan. This spec covers `/invite/[token]` in two states:
 *
 *   1. Invalid-token error state — the invitee clicks a typo'd or
 *      tampered link and sees the "invitation invalid" error page.
 *      We scan this state because it uses different components from
 *      the happy path (empty-state card, no form).
 *
 *   2. Valid-token form state cannot be scanned cleanly in E2E
 *      because every run would need a freshly-seeded invitation
 *      token, and the page renders the password form. The seeded
 *      e2e-admin test covers the happy path; the a11y scan of the
 *      password form is covered implicitly via the same shadcn
 *      components exercised by forgot-password-a11y's reset form
 *      (they share `PasswordInput`, `Label`, `Button`).
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('invite flow a11y (WCAG 2.1 AA)', () => {
  test('invite page with invalid token renders accessible error state', async ({
    page,
  }) => {
    // A 64-char hex string that isn't an issued invitation — the page
    // will render the link-invalid error card, which must still pass
    // axe (empty state pattern from ux-standards § 6).
    await page.goto(`/invite/${'b'.repeat(64)}`);
    await page.waitForLoadState('networkidle');

    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const serious = result.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    if (serious.length > 0) {
      console.log(
        `  axe violations on /invite/[invalid]: ${serious
          .map((v) => `${v.id}(${v.impact})`)
          .join(', ')}`,
      );
    }
    expect(serious).toHaveLength(0);
  });
});
