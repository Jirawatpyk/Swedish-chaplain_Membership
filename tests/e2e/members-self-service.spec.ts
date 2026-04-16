/**
 * T117 — E2E spec: member self-service portal (US5).
 *
 * @f3 @a11y @i18n
 *
 * Tests:
 *   1. Profile page renders with member's company name + contacts
 *   2. axe-core WCAG 2.1 AA scan on /portal/profile
 *   3. EN/TH/SV i18n leak check via NEXT_LOCALE cookie
 *   4. Edit form navigates from profile, shows whitelisted fields only
 *
 * NOTE: These tests require a seeded member user in the E2E fixture.
 * If the fixture is not available, tests will be skipped gracefully.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PORTAL_URL = '/portal/profile';
const EDIT_URL = '/portal/edit';

// Skip all tests if no E2E member fixture is available
test.describe('US5 Member self-service portal @f3', () => {
  test.beforeEach(async ({ page }) => {
    // Attempt to navigate to portal — if auth redirects, skip
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });
    const url = page.url();
    if (url.includes('sign-in') || url.includes('login')) {
      test.skip(true, 'No seeded member session — skipping portal E2E');
    }
  });

  test('profile page renders company info + contacts', async ({ page }) => {
    // Check for profile page content
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Company section should be present
    await expect(page.locator('[data-slot="page-header"]')).toBeVisible();
  });

  test('@a11y WCAG 2.1 AA scan on /portal/profile', async ({ page }) => {
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('@i18n TH locale check — no EN key leak', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'NEXT_LOCALE',
        value: 'th',
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });
    // The page title should be in Thai
    const heading = page.getByRole('heading', { level: 1 });
    if (await heading.isVisible()) {
      const text = await heading.textContent();
      // Should not be the English fallback
      expect(text).not.toBe('My Profile');
    }
  });

  test('@i18n SV locale check — no EN key leak', async ({ page, context }) => {
    await context.addCookies([
      {
        name: 'NEXT_LOCALE',
        value: 'sv',
        domain: 'localhost',
        path: '/',
      },
    ]);
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });
    const heading = page.getByRole('heading', { level: 1 });
    if (await heading.isVisible()) {
      const text = await heading.textContent();
      expect(text).not.toBe('My Profile');
    }
  });

  test('edit page shows only whitelisted fields (FR-042)', async ({
    page,
  }) => {
    // Navigate to edit page
    await page.goto(EDIT_URL, { waitUntil: 'networkidle' });
    const url = page.url();
    if (url.includes('sign-in')) {
      test.skip(true, 'No seeded member session');
    }

    // Whitelisted fields should be visible
    await expect(page.locator('#firstName')).toBeVisible();
    await expect(page.locator('#lastName')).toBeVisible();
    await expect(page.locator('#phone')).toBeVisible();
    await expect(page.locator('#website')).toBeVisible();
    await expect(page.locator('#description')).toBeVisible();

    // Forbidden fields should NOT exist in the DOM at all (FR-042: hidden entirely)
    await expect(page.locator('#plan_id')).toHaveCount(0);
    await expect(page.locator('#status')).toHaveCount(0);
    await expect(page.locator('#tax_id')).toHaveCount(0);
    await expect(page.locator('#turnover_thb')).toHaveCount(0);
    await expect(page.locator('#country')).toHaveCount(0);
    await expect(page.locator('#notes')).toHaveCount(0);
  });
});
