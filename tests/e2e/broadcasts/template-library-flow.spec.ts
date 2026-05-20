/**
 * T096 (F7.1a US7) — E2E happy path for template library flow.
 *
 * Playwright + axe-core. Env-gated `describe.skipIf` matching the
 * pattern of `tests/e2e/broadcasts/image-upload-allowlist.spec.ts`:
 * skips when `E2E_ADMIN_EMAIL` + `E2E_MEMBER_EMAIL` are not set in
 * the staging env.
 *
 * RED-first per Constitution Principle II — the stub fails at the
 * first locator that doesn't yet have a corresponding rendered
 * component. GREEN lands across Phase 5G (admin pages) + 5H
 * (components) when the surfaces are wired.
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

const skipReason = !ADMIN_EMAIL || !ADMIN_PASSWORD || !MEMBER_EMAIL || !MEMBER_PASSWORD;

test.describe('F7.1a US7 template library flow @template-library', () => {
  test.skip(skipReason, 'E2E credentials not configured');

  test('admin sees 15 starter templates with Starter badges', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.goto('/admin/broadcasts/templates');

    // 15 starter rows × 3 locales = visible (5 names; locale filter)
    const rows = page.getByRole('row');
    await expect(rows).toHaveCount(16); // 15 + 1 header
    // Starter badge present on seeded rows
    const starterBadges = page.getByText(/starter/i);
    await expect(starterBadges.first()).toBeVisible();

    // a11y baseline scan
    const a11yResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(a11yResults.violations).toEqual([]);
  });

  test('admin creates new template → appears in list', async ({ page }) => {
    // (signed-in from previous test via shared storage state, if
    // configured. Otherwise re-sign-in here.)
    await page.goto('/admin/broadcasts/templates/new');

    await page.getByLabel(/name/i).fill('E2E Test Template');
    await page.getByLabel(/subject/i).fill('Test {{chamber_name}}');
    // Tiptap editor — fill via keyboard focus
    await page.getByRole('textbox', { name: /body/i }).fill('<p>Hello [member name].</p>');
    await page.getByRole('button', { name: /save/i }).click();

    await page.waitForURL('**/admin/broadcasts/templates');
    await expect(page.getByText('E2E Test Template')).toBeVisible();
  });

  test('member picks template → draft body populated with substituted chamber_name', async ({ page }) => {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.goto('/portal/broadcasts/new');
    // Template picker is first action
    await page.getByRole('combobox', { name: /template/i }).click();
    await page.getByRole('option', { name: /monthly newsletter/i }).click();

    // Body now contains substituted chamber name (SweCham) + bracket placeholder
    const body = page.getByRole('textbox', { name: /body/i });
    await expect(body).toContainText('SweCham');
    await expect(body).toContainText('['); // bracket placeholder survived

    // a11y scan on compose with picker open
    const a11yResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(a11yResults.violations).toEqual([]);
  });
});
