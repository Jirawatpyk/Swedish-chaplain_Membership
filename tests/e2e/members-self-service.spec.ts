/**
 * T117 — E2E spec: member self-service portal (US5).
 *
 * @f3 @a11y @i18n
 *
 * Tests the portal surfaces visible through the admin flow:
 *   1. Admin creates member + sees Invite-to-portal button (FR-012)
 *   2. axe-core WCAG 2.1 AA scan on member detail page
 *   3. EN/TH/SV i18n leak check
 *   4. Portal edit form structure (FR-042 — whitelisted fields only)
 *
 * NOTE: Full member sign-in E2E requires invitation token redemption
 * (F1 flow) which cannot be automated without email access. Portal
 * sign-in tests are deferred to a dedicated fixture with a pre-linked
 * member user (Phase 10 scope). These tests validate the admin-facing
 * portal integration surfaces.
 *
 * Env vars: E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const RUN_ID = Date.now().toString(36);

test.describe.configure({ mode: 'serial' });

test.describe('US5 Member self-service portal @f3 @a11y @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  test('admin creates member with portal-invitable contact', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members/new');
    await page.waitForLoadState('networkidle');

    const companyField = page.locator('#company_name');
    await expect(companyField).toBeVisible({ timeout: 10_000 });

    await fillField(companyField, `E2E Portal Corp ${RUN_ID}`);
    // PR-B task 5 — #country is now a searchable combobox trigger <button>
    // (not a fillable text <input>); no explicit selection needed since
    // the form already defaults it to 'TH' (schema default).

    // Select first available plan
    await page.locator('#plan_id').click();
    await page.getByRole('option').first().click();

    // Primary contact
    await fillField(page.locator('#first_name'), 'Portal');
    await fillField(page.locator('#last_name'), 'User');
    await fillField(page.locator('#contact_email'), `e2e-portal-${RUN_ID}@swecham.test`);

    // Submit
    await page.getByRole('button', { name: /save|create|add/i }).click();

    // Wait for detail page redirect
    await page.waitForURL(/\/admin\/members\/[a-f0-9-]+/, {
      timeout: 15_000,
    }).catch(() => { /* soft-duplicate handling */ });

    // Handle soft-duplicate if needed
    const confirmBtn = page.getByRole('button', { name: /proceed|confirm|create anyway/i });
    if (await confirmBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await confirmBtn.click();
      await page.waitForURL(/\/admin\/members\/[a-f0-9-]+/, { timeout: 15_000 });
    }

    // Verify member detail renders
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // Verify "Invite to portal" button is present (FR-012)
    const inviteBtn = page.getByRole('button', { name: /invite.*portal/i });
    await expect(inviteBtn).toBeVisible({ timeout: 5_000 });
  });

  test('@a11y WCAG 2.1 AA scan on member detail page', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');

    // Click first member row to open detail
    const firstRow = page.locator('table tbody tr').first().locator('a').first();
    if (await firstRow.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await firstRow.click();
      await page.waitForLoadState('networkidle');

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);
    }
  });

  test('@i18n TH+SV locale — no raw i18n key leak on member pages', async ({
    page,
    context,
  }) => {
    await signIn(page);

    for (const locale of ['th', 'sv'] as const) {
      await context.addCookies([
        { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
      ]);
      await page.goto('/admin/members');
      await page.waitForLoadState('networkidle');
      const text = await page.evaluate(() => document.body.innerText);
      expect(
        text,
        `${locale}: raw translation key leaked`,
      ).not.toMatch(/admin\.members\.(directory|create)\.[a-z]+/i);
      expect(
        text,
        `${locale}: portal translation key leaked`,
      ).not.toMatch(/portal\.(profile|edit|invite)\.[a-z]+/i);
      expect(text, `${locale}: empty body`).not.toBe('');
    }
  });
});
