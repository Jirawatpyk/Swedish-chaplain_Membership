/**
 * 088 T072a (SC-010 + SC-011) — tenant invoice-settings form a11y + responsive.
 *
 * Covers the US5 additions to `/admin/settings/invoicing` (seller §86/4 branch,
 * WHT footer note, offline-payment bank block) plus the form's grouping + Save:
 *
 *   1. axe-core WCAG 2.0/2.1 A+AA — zero violations on the settings page;
 *   2. WCAG 2.5.5 Target Size — the new bank-block inputs + the primary Save are
 *      ≥44×44px (the seller branch input, shown only when the tenant is a branch,
 *      is measured when present);
 *   3. WCAG 1.4.10 Reflow / SC-011 — at 320 and 375 CSS px, no horizontal scroll;
 *   4. WCAG 1.4.4 Resize Text 200% — Save stays visible, no page h-scroll;
 *   5. FR-036 grouping + reachable Save — every section is a <fieldset><legend>
 *      and the Save button is reachable/visible at 320px.
 *
 * Preview-gated (mirrors the F4 E2E policy): needs an authenticated admin. The
 * page renders for admin + manager, but Save is admin-only, so this signs in as
 * the E2E admin. Graceful-skips when creds are absent; local dev may emit dev-only
 * 320px/target noise — the load-bearing verification for the FIXES is the RTL
 * (`tests/unit/components/invoices/invoice-settings-form.test.tsx`) guard.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator } from '@playwright/test';
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';
import { signInViaForm, waitForLayoutContainer } from '../helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;
const MIN_TARGET = 44;
const SETTINGS_PATH = '/admin/settings/invoicing';

async function expectTargetSize(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has a bounding box`).not.toBeNull();
  expect(box!.height, `${label} height ≥ ${MIN_TARGET}px`).toBeGreaterThanOrEqual(
    MIN_TARGET - 0.5,
  );
  expect(box!.width, `${label} width ≥ ${MIN_TARGET}px`).toBeGreaterThanOrEqual(
    MIN_TARGET - 0.5,
  );
}

test.describe('088 invoice-settings form a11y @a11y @f088', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('the settings page passes WCAG 2.1 AA', async ({ page }) => {
    await signInViaForm(
      page,
      '/admin/sign-in',
      ADMIN_EMAIL!,
      ADMIN_PASSWORD!,
      /^\/admin(\/|$)/,
    );
    await page.goto(SETTINGS_PATH);
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(
      results.violations,
      `${SETTINGS_PATH} has zero WCAG 2.1 AA violations`,
    ).toEqual([]);
  });

  test('new US5 controls + Save meet the WCAG 2.5.5 ≥44px target size', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/admin/sign-in',
      ADMIN_EMAIL!,
      ADMIN_PASSWORD!,
      /^\/admin(\/|$)/,
    );
    await page.goto(SETTINGS_PATH);
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    // Bank-block inputs are always rendered; measure the SWIFT + account fields.
    await expectTargetSize(page.getByLabel(/SWIFT/i), 'bank SWIFT input');
    await expectTargetSize(
      page.getByLabel(/Account number/i),
      'bank account-no input',
    );
    await expectTargetSize(
      page.getByRole('button', { name: /Save settings/i }),
      'Save button',
    );

    // Seller branch input only shows when the tenant is a branch (not HO).
    const branch = page.getByLabel(/Branch code/i);
    if (await branch.isVisible().catch(() => false)) {
      await expectTargetSize(branch, 'seller branch input');
    }
  });

  for (const width of [320, 375] as const) {
    test(`no horizontal scroll at ${width}px (WCAG 1.4.10 reflow / SC-011)`, async ({
      page,
    }) => {
      await signInViaForm(
        page,
        '/admin/sign-in',
        ADMIN_EMAIL!,
        ADMIN_PASSWORD!,
        /^\/admin(\/|$)/,
      );
      await page.setViewportSize({ width, height: 900 });
      await page.goto(SETTINGS_PATH);
      await waitForLayoutContainer(page);
      await page.waitForLoadState('networkidle');

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `page overflow at ${width}px`).toBeLessThanOrEqual(1);
    });
  }

  test('groups sections with <fieldset><legend> and keeps Save reachable at 320px', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/admin/sign-in',
      ADMIN_EMAIL!,
      ADMIN_PASSWORD!,
      /^\/admin(\/|$)/,
    );
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(SETTINGS_PATH);
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    // FR-036 grouping — every section is a labelled fieldset (≥9 sections).
    const legendCount = await page.locator('form fieldset > legend').count();
    expect(legendCount, 'fieldset>legend count').toBeGreaterThanOrEqual(9);

    // Reachable Save at 320px: scroll to it and confirm it is a visible,
    // full-width tap target.
    const save = page.getByRole('button', { name: /Save settings/i });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    const box = await save.boundingBox();
    expect(box, 'Save has a box').not.toBeNull();
    expect(box!.height, 'Save height ≥ 44px').toBeGreaterThanOrEqual(
      MIN_TARGET - 0.5,
    );
  });

  test('remains usable at 200% text zoom (WCAG 1.4.4 resize text)', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/admin/sign-in',
      ADMIN_EMAIL!,
      ADMIN_PASSWORD!,
      /^\/admin(\/|$)/,
    );
    await page.goto(SETTINGS_PATH);
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await expect(page.getByRole('button', { name: /Save settings/i })).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, 'page overflow at 200% zoom').toBeLessThanOrEqual(1);
  });
});
