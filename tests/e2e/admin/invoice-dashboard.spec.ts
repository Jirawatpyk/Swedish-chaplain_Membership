/**
 * 124 slice 3 — E2E: the invoice dashboard at `/admin/finance`.
 *
 * @a11y @i18n
 *
 *   1. admin: the four tiles and six cards render; an aging row opens the
 *      invoice list for that range and the list counts what the row said
 *      (US2.2); the Outstanding tile's list counts the tile's invoices (US2.1);
 *   2. manager: every figure, but no Record payment button and no draft rows
 *      in the page (US4.1/4.2);
 *   3. filters: Invoice type = Membership writes `?type=membership`, shows a
 *      chip, and the drill-down links carry `subject=membership` (US3.1, US2.5);
 *   4. axe-core WCAG 2.1 AA in light and dark (US6.2);
 *   5. EN / TH / SV render without a key leak (US6.3).
 *
 * Read-only against the dev branch: Record payment is NOT driven here (it
 * would issue a receipt number on shared data); its trigger, gating and focus
 * are unit-tested and the dialog has its own suites.
 *
 * The page is behind FEATURE_INVOICE_DASHBOARD. Run it against a server that
 * has the flag on (the branch's :3400 per the run-chamber-os skill); where
 * the flag is off the route 404s and every test here skips, saying so.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import en from '@/i18n/messages/en.json';
import { expect, test } from '../fixtures';
import { signInAsAdmin } from '../helpers/admin-session';
import { signInAsManager } from '../helpers/manager-session';
import { clearE2ERateLimits } from '../helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const PAGE = '/admin/finance';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;
const D = en.admin.invoiceDashboard;

/** Opens the page; skips the test when the flag is off on this server. */
async function openDashboard(page: Page, query = ''): Promise<void> {
  const response = await page.goto(`${PAGE}${query}`, { waitUntil: 'domcontentloaded' });
  test.skip(response?.status() === 404, 'FEATURE_INVOICE_DASHBOARD is off on this server');
  await expect(page.getByRole('heading', { level: 1, name: D.title })).toBeVisible();
}

/** The invoice list's own result count (AURA FilterBar). */
async function listCount(page: Page): Promise<number> {
  const count = page.locator('.aura-filterbar__count:visible').first();
  await expect(count).toHaveText(/\d/);
  return Number((await count.innerText()).replace(/[^\d]/g, ''));
}

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.describe('124 — Invoice dashboard @a11y @i18n', () => {
  test.skip(!ADMIN_EMAIL, 'Set E2E_ADMIN_* (seeded by scripts/seed-e2e-user.ts)');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('1. admin: tiles and cards render; drill-downs count what the figures say', async ({ page }) => {
    await signInAsAdmin(page);
    await openDashboard(page);
    const tiles = page.getByTestId('dashboard-tiles');
    await expect(tiles).toBeVisible();
    for (const title of [D.aging.title, D.attention.title, D.oldest.title, D.trend.title, D.methods.title]) {
      await expect(page.getByRole('heading', { level: 2, name: title })).toBeVisible();
    }

    // The card streams in its own Suspense island: wait for it before counting.
    await expect(page.getByTestId('aging-rows')).toBeVisible();
    const agingLink = page.getByTestId('aging-rows').getByRole('link').first();
    test.skip((await agingLink.count()) === 0, 'no unpaid invoice on this branch to drill into');
    const name = (await agingLink.getAttribute('aria-label')) ?? '';
    const expected = Number(/(\d[\d,]*) invoices?$/.exec(name)?.[1]?.replace(/,/g, '') ?? NaN);
    await agingLink.click();
    await expect(page).toHaveURL(/\/admin\/invoices\?status=(issued|overdue)/);
    expect(await listCount(page)).toBe(expected);

    await openDashboard(page);
    const caption = await tiles.getByText(/unpaid invoices? · as of today/).innerText();
    const outstanding = Number(caption.replace(/[^\d]/g, ''));
    await tiles.getByRole('link', { name: new RegExp(D.tiles.outstanding) }).click();
    await expect(page).toHaveURL(/\/admin\/invoices\?status=issued/);
    expect(await listCount(page)).toBe(outstanding);

    // US2.1's other half: the Overdue tile against the list's own overdue.
    await openDashboard(page);
    const overdueCaption = await tiles.getByText(/past due · as of today/).innerText();
    const overdue = Number(overdueCaption.replace(/[^\d]/g, ''));
    await tiles.getByRole('link', { name: new RegExp(`^${D.tiles.overdue}`) }).click();
    await expect(page).toHaveURL(/\/admin\/invoices\?status=overdue/);
    expect(await listCount(page)).toBe(overdue);
  });

  test('2. manager: figures, but no Record payment and no draft rows', async ({ page }) => {
    test.skip(!MANAGER_EMAIL, 'Set E2E_MANAGER_*');
    await signInAsManager(page);
    await openDashboard(page);
    await expect(page.getByRole('heading', { level: 2, name: D.oldest.title })).toBeVisible();
    await expect(page.getByTestId('oldest-overdue-record-payment')).toHaveCount(0);
    await expect(page.locator('[data-attention="manualDrafts"], [data-attention="autoRenewalDrafts"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: D.states.newInvoice })).toHaveCount(0);
  });

  test('3. a filter writes the URL, shows a chip and narrows the drill-downs', async ({ page }) => {
    await signInAsAdmin(page);
    await openDashboard(page, '?type=membership');
    await expect(page.locator('.aura-filterbar__chips:visible')).toContainText(
      `${D.filters.type}: ${D.filters.typeMembership}`,
    );
    await expect(page.getByTestId('dashboard-tiles').getByRole('link', { name: new RegExp(D.tiles.outstanding) })).toHaveAttribute(
      'href',
      '/admin/invoices?status=issued&subject=membership',
    );
    // An unknown value falls back without an error page (US3.4).
    await openDashboard(page, '?type=nonsense&fy=1999');
    await expect(page.locator('.aura-filterbar__chips:visible')).toHaveCount(0);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`4. no axe violations (${theme}) @a11y`, async ({ page }) => {
      await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
      await signInAsAdmin(page);
      await openDashboard(page);
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  for (const locale of ['en', 'th', 'sv'] as const) {
    test(`5. renders in ${locale.toUpperCase()} without key leaks @i18n`, async ({ page, context, baseURL }) => {
      await signInAsAdmin(page);
      await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL ?? 'http://localhost:3100' }]);
      const response = await page.goto(PAGE, { waitUntil: 'networkidle' });
      test.skip(response?.status() === 404, 'FEATURE_INVOICE_DASHBOARD is off on this server');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const text = await page.locator('#main-content').innerText();
      expect(text).not.toContain('MISSING_MESSAGE');
      expect(text).not.toMatch(/\b(admin|nav|breadcrumb)\.[a-z]+\.[a-zA-Z_.]+\b/);
      if (locale === 'th') expect(text).toMatch(/25\d\d/);
    });
  }
});
