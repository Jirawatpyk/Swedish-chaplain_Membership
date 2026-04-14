/**
 * T151 — E2E: Command palette (US6).
 *
 * Covers the US6 acceptance flow:
 *   1. ⌘K / Ctrl+K opens the palette from any admin page; search input focused.
 *   2. Esc closes the palette and restores focus to the previously-active element.
 *   3. Arrow-key navigation moves between results; Enter navigates to the
 *      highlighted target.
 *   4. Role filtering: manager sees no admin-only actions (create / clone /
 *      edit fees).
 *   5. Reduced-motion users get no open animation.
 *   6. Cold-open timing: first open completes within 300 ms p95; subsequent
 *      warm opens complete within 100 ms p95 (critique P8).
 *
 * Gated on seeded admin + manager accounts — skipped when unavailable.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe.configure({ mode: 'serial' });

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/admin/sign-in');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); }, { timeout: 10_000 });
}

test.describe('command palette — US6', () => {
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('⌘K / Ctrl+K opens the palette with the search input focused', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
    );
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/plans');

    await page.keyboard.press(`${MOD}+KeyK`);

    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();

    const search = palette.getByRole('combobox');
    await expect(search).toBeFocused();
  });

  test('Esc closes the palette and restores focus to the previously-active element', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
    );
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/plans');

    // Focus a known element so we can assert focus returns there
    const focusTarget = page.getByRole('link', { name: /plans/i }).first();
    await focusTarget.focus();

    await page.keyboard.press(`${MOD}+KeyK`);
    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(focusTarget).toBeFocused();
  });

  test('type → arrow → Enter navigates to matched plan', async ({ page }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
    );
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/plans');

    await page.keyboard.press(`${MOD}+KeyK`);
    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();

    await palette.getByRole('combobox').fill('plat');

    // Wait for debounced filter to settle
    await page.waitForTimeout(300);

    // cmdk needs explicit arrow-down to highlight the first option before
    // Enter can select it (the auto-select-first behavior is not reliable
    // across React 19 + cmdk versions).
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await page.waitForURL(/\/admin\/plans\/\d{4}\/platinum/, {
      timeout: 5_000,
    });
  });

  test('manager role: no admin-only actions appear in the palette', async ({
    page,
  }) => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL and E2E_MANAGER_PASSWORD',
    );
    await signIn(page, MANAGER_EMAIL!, MANAGER_PASSWORD!);
    await page.goto('/admin/plans');

    await page.keyboard.press(`${MOD}+KeyK`);
    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();

    // Query the static action registry — admin-only entries must NOT appear
    await palette.getByRole('combobox').fill('clone');
    await page.waitForTimeout(150);
    await expect(palette.getByText(/clone year/i)).toHaveCount(0);

    await palette.getByRole('combobox').fill('create');
    await page.waitForTimeout(150);
    await expect(palette.getByText(/create new plan/i)).toHaveCount(0);

    await palette.getByRole('combobox').fill('fee');
    await page.waitForTimeout(150);
    await expect(palette.getByText(/edit fee configuration/i)).toHaveCount(0);
  });

  test('reduced-motion disables open animation', async ({ browser }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
    );
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/plans');

    await page.keyboard.press(`${MOD}+KeyK`);
    const palette = page.getByRole('dialog', { name: /command palette/i });
    await expect(palette).toBeVisible();
    // With reduced motion, the transition-duration should be effectively 0
    // (assertion is the visibility is reached without a transition wait).
    const transition = await palette.evaluate(
      (el) => window.getComputedStyle(el).transitionDuration,
    );
    expect(['0s', '0ms']).toContain(transition);
    await ctx.close();
  });

  test('cold-open timing: first open ≤ 300 ms; warm open ≤ 100 ms (critique P8)', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
    );
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/plans');

    // Cold open
    const coldStart = Date.now();
    await page.keyboard.press(`${MOD}+KeyK`);
    await expect(
      page.getByRole('dialog', { name: /command palette/i }),
    ).toBeVisible();
    const coldMs = Date.now() - coldStart;
    expect(coldMs).toBeLessThan(300);

    // Close and warm-open
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('dialog', { name: /command palette/i }),
    ).toBeHidden();

    const warmStart = Date.now();
    await page.keyboard.press(`${MOD}+KeyK`);
    await expect(
      page.getByRole('dialog', { name: /command palette/i }),
    ).toBeVisible();
    const warmMs = Date.now() - warmStart;
    expect(warmMs).toBeLessThan(100);
  });
});
