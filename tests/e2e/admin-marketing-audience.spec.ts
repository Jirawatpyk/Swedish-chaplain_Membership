/**
 * 108 PR-D T047 — E2E: Marketing audience page + member-page toggle.
 *
 * @a11y @i18n
 *
 *   1. marketing persona: switch a receiving secondary OFF (10-s Undo toast),
 *      Undo it, and prove BOTH toggles reached the server — two audit rows
 *      (`opted_out` then `opted_in`) — i.e. the Undo minted its own
 *      Idempotency-Key instead of replaying the "off" outcome (FR-030b/c);
 *   2. manager persona: the page is read-only — states visible, no switch
 *      (FR-034 / FR-035);
 *   3. the FR-027a pre-flight preset lists only secondaries currently on;
 *   4. axe-core WCAG 2.1/2.2 AA on the page;
 *   5. EN / TH / SV render without key leaks;
 *   6. 320 px: the table scrolls inside its container, never the page, and
 *      the switch stays reachable at ≥ 24×24 px (FR-035c);
 *   7. member detail: the primary badge descriptor, the state badge, and the
 *      switch for marketing / none for manager (FR-031 / FR-034).
 *
 * Seeded by `helpers/marketing-audience-seed.ts` (fixed ids, cleaned up in
 * afterAll). Run with `--workers=1` (the fixture is shared and the toggles
 * write audit rows).
 */
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import en from '@/i18n/messages/en.json';
import { expect, test } from './fixtures';
import { signInAsMarketing } from './helpers/marketing-session';
import { signInAsManager } from './helpers/manager-session';
import { clearE2ERateLimits } from './helpers/rate-limit';
import {
  MARKETING_AUDIENCE_FIXTURE as F,
  cleanupMarketingAudienceFixture,
  readMarketingAuditTrail,
  seedMarketingAudienceFixture,
} from './helpers/marketing-audience-seed';

const MARKETING_EMAIL = process.env.E2E_MARKETING_EMAIL;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;
const LOCALES = ['en', 'th', 'sv'] as const;
const PAGE = '/admin/marketing/audience';
const FIXTURE_QUERY = `?q=${encodeURIComponent('Audience Fixture')}&eligible=0`;

const fullName = (c: { firstName: string; lastName: string }) => `${c.firstName} ${c.lastName}`;

async function setLocale(context: BrowserContext, locale: (typeof LOCALES)[number]): Promise<void> {
  await context.addCookies([{ name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' }]);
}

function rowFor(page: Page, contactId: string) {
  return page.locator(`[data-contact-id="${contactId}"]`);
}

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.describe('108 PR-D — Marketing audience page @a11y @i18n', () => {
  test.skip(
    !MARKETING_EMAIL || !MANAGER_EMAIL,
    'Set E2E_MARKETING_* and E2E_MANAGER_* (seeded by scripts/seed-e2e-user.ts)',
  );

  let seededAt: Date | null = null;
  const seeded = () => seededAt !== null;

  test.beforeAll(async () => {
    await clearE2ERateLimits();
    seededAt = await seedMarketingAudienceFixture();
  });

  test.afterAll(async () => {
    await cleanupMarketingAudienceFixture();
  });

  test.beforeEach(() => {
    test.skip(!seeded(), 'fixture could not be seeded (DATABASE_URL / active plan missing)');
  });

  test('1. marketing switches a secondary OFF, Undo switches it back — two audit rows, two keys', async ({ page }) => {
    await signInAsMarketing(page);
    await page.goto(`${PAGE}${FIXTURE_QUERY}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: en.admin.marketing.audience.title })).toBeVisible();

    const row = rowFor(page, F.secondaryOn.contactId);
    await expect(row).toHaveAttribute('data-marketing-state', 'on');
    // The switch is named for the contact and its current state.
    const sw = row.getByRole('switch', { name: new RegExp(fullName(F.secondaryOn)) });
    await expect(sw).toHaveAttribute('aria-checked', 'true');

    await sw.click();
    // 10-second Undo toast, no confirmation dialog (FR-030c).
    const undo = page.getByRole('button', { name: en.shared.marketing.switch.undo });
    await expect(undo).toBeVisible({ timeout: 10_000 });
    await expect(rowFor(page, F.secondaryOn.contactId)).toHaveAttribute(
      'data-marketing-state',
      'off_by_staff',
      { timeout: 15_000 },
    );

    await undo.click();
    await expect(rowFor(page, F.secondaryOn.contactId)).toHaveAttribute('data-marketing-state', 'on', {
      timeout: 15_000,
    });

    // Both writes reached the server: a replayed key would have returned the
    // stored "off" outcome and written nothing the second time.
    await expect
      .poll(() => readMarketingAuditTrail(F.secondaryOn.contactId, seededAt!), { timeout: 15_000 })
      .toEqual(['contact_marketing_opted_out', 'contact_marketing_opted_in']);
  });

  test('2. manager sees the states read-only — no switch anywhere (FR-034)', async ({ page }) => {
    await signInAsManager(page);
    await page.goto(`${PAGE}${FIXTURE_QUERY}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('audience-read-only')).toBeVisible();
    await expect(rowFor(page, F.secondaryStaffOff.contactId)).toHaveAttribute(
      'data-marketing-state',
      'off_by_staff',
    );
    await expect(page.getByRole('switch')).toHaveCount(0);
  });

  test('3. the pre-flight preset lists only secondaries currently on (FR-027a)', async ({ page }) => {
    await signInAsMarketing(page);
    await page.goto(`${PAGE}${FIXTURE_QUERY}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('audience-preflight-preset').click();
    await page.waitForURL((u) => {
      const p = new URL(u).searchParams;
      return p.get('kind') === 'secondary' && p.get('state') === 'on' && p.get('eligible') === '1';
    });
    // Narrow to the fixture again (the preset resets the search).
    await page.goto(`${PAGE}?kind=secondary&state=on&eligible=1&q=${encodeURIComponent('Audience Fixture')}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(rowFor(page, F.secondaryOn.contactId)).toBeVisible();
    await expect(rowFor(page, F.secondaryStaffOff.contactId)).toHaveCount(0);
    await expect(rowFor(page, F.primary.contactId)).toHaveCount(0);
  });

  test('4. no axe violations (WCAG 2.1 AA + 2.2 AA) @a11y', async ({ page }) => {
    await signInAsMarketing(page);
    await page.goto(`${PAGE}${FIXTURE_QUERY}`, { waitUntil: 'networkidle' });
    await expect(page.getByTestId('marketing-audience-table')).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
    expect(results.violations).toEqual([]);
  });

  for (const locale of LOCALES) {
    test(`5. renders in ${locale.toUpperCase()} without key leaks @i18n`, async ({ page, context }) => {
      // Sign in FIRST (the helper finds the EN sign-in labels), then switch
      // the locale cookie for the page under test.
      await signInAsMarketing(page);
      await setLocale(context, locale);
      await page.goto(`${PAGE}${FIXTURE_QUERY}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      // `#main-content` — the staff shell renders a second <main> (sidebar inset).
      const text = await page.locator('#main-content').innerText();
      expect(text).not.toContain('MISSING_MESSAGE');
      // A raw dotted key (e.g. `admin.marketing.audience.title`) means a
      // missing translation fell through to the key itself.
      expect(text).not.toMatch(/\b(admin|shared|nav|breadcrumb)\.[a-z]+\.[a-zA-Z_.]+\b/);
    });
  }

  test('6. 320 px: container scroll only, switch reachable at ≥ 24×24 px (FR-035c)', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await signInAsMarketing(page);
    await page.goto(`${PAGE}${FIXTURE_QUERY}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('marketing-audience-table')).toBeVisible();

    const pageScrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(pageScrolls, 'the page must never scroll horizontally').toBe(false);

    const containerScrolls = await page
      .getByTestId('marketing-audience-table')
      .evaluate((table) => {
        const wrapper = table.parentElement;
        return wrapper !== null && wrapper.scrollWidth > wrapper.clientWidth;
      });
    expect(containerScrolls, 'the table scrolls inside its own container').toBe(true);

    const sw = rowFor(page, F.secondaryOn.contactId).getByRole('switch');
    await sw.scrollIntoViewIfNeeded();
    await expect(sw).toBeVisible();
    const box = await sw.locator('..').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(24);
    expect(box!.height).toBeGreaterThanOrEqual(24);
  });

  test('7. member detail: Primary descriptor, state badge, switch for marketing — none for manager', async ({ page }) => {
    await signInAsMarketing(page);
    await page.goto(`/admin/members/${F.memberId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(en.admin.members.detail.marketing.primaryDescriptor)).toBeVisible();
    await expect(page.locator('[data-marketing-state="off_by_staff"]').first()).toBeVisible();
    await expect(
      page.getByRole('switch', { name: new RegExp(fullName(F.secondaryStaffOff)) }),
    ).toBeVisible();

    await page.context().clearCookies();
    await signInAsManager(page);
    await page.goto(`/admin/members/${F.memberId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('[data-marketing-state="off_by_staff"]').first()).toBeVisible();
    await expect(page.getByRole('switch')).toHaveCount(0);
  });
});
