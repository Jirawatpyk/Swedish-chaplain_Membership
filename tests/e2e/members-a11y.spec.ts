/**
 * T148 — E2E: comprehensive axe-core WCAG 2.1 AA scan across all F3
 * admin surfaces (FR-024).
 *
 * @f3 @a11y
 *
 * Runs axe-core on every F3 admin surface that renders significant HTML:
 *   1. /admin/members         — directory table
 *   2. /admin/members/new     — create-member form
 *   3. /admin/members/:id     — member detail page
 *   4. /admin/members/:id/edit — edit form
 *   5. /admin/members/:id/timeline — timeline view
 *
 * WCAG 2.2 SC 2.5.8 (target-size) is included via `wcag22aa` tag.
 * Each page is scanned AFTER the data has loaded (networkidle) to
 * avoid false violations on skeleton placeholders.
 *
 * Portal surfaces (/portal/*) require a member session — covered by
 * the per-story @a11y scans (T114–T117, T127–T129, T137) which run
 * during the invite + portal flow with an admin-created account.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

test.describe.configure({ mode: 'serial' });

test.describe('F3 admin comprehensive a11y scan @f3 @a11y', () => {
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

  async function firstMemberId(page: Page): Promise<string | null> {
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    const href = await page
      .locator('tbody tr:first-child a')
      .first()
      .getAttribute('href')
      .catch(() => null);
    if (!href) return null;
    return href.match(/\/admin\/members\/([0-9a-f-]+)/)?.[1] ?? null;
  }

  test('1. /admin/members directory — no axe violations', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('2. /admin/members/new create form — no axe violations', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/admin/members/new');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('3. /admin/members/:id detail — no axe violations', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping detail a11y scan');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('4. /admin/members/:id/edit — no axe violations', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping edit a11y scan');
      return;
    }
    await page.goto(`/admin/members/${memberId}/edit`);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('5. /admin/members/:id/timeline — no axe violations', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping timeline a11y scan');
      return;
    }
    await page.goto(`/admin/members/${memberId}/timeline`);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('6. /admin/members directory with bulk bar open — no axe violations', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });

    // Select a row to reveal the bulk action bar
    const firstCheckbox = page
      .locator('tbody tr:first-child [data-slot="checkbox"]')
      .first();
    const checkboxVisible = await firstCheckbox.isVisible({ timeout: 5_000 }).catch(() => false);
    if (checkboxVisible) {
      await firstCheckbox.click();
      await page.getByRole('toolbar').waitFor({ state: 'visible', timeout: 5_000 });
    }

    const results = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
