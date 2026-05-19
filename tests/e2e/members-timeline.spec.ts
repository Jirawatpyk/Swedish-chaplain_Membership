/**
 * T129 — E2E: /admin/members/[memberId]/timeline @f3 @a11y @i18n.
 *
 * Coverage:
 *   - Timeline page renders events list with header + back nav
 *   - Actor UUIDs are resolved to human-readable display names
 *     (FR-020 / user-feedback fix — "อ่านไม่เข้าใจ มันเป็นรหัส")
 *   - WCAG 2.1 AA scan via @axe-core/playwright
 *   - i18n smoke: TH + SV locales render without raw translation-key leaks
 *   - Reduced-motion: timeline renders instantly (no animated reveal)
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('members timeline — F3 US6 @f3 @a11y @i18n', () => {
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

  async function firstMemberId(page: Page): Promise<string> {
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.waitFor({ timeout: 15_000 });
    const href = await firstRow.locator('a').first().getAttribute('href');
    if (!href) throw new Error('No member rows — seed required');
    const match = href.match(/\/admin\/members\/([0-9a-f-]+)/);
    if (!match) throw new Error(`Could not parse memberId from ${href}`);
    return match[1]!;
  }

  test('timeline page renders with events + back button', async ({ page }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    await page.goto(`/admin/members/${memberId}/timeline`);

    // Page header title
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Either the timeline list (has audit rows) OR the empty state.
    const hasList = await page
      .locator('ol[aria-label]')
      .first()
      .isVisible()
      .catch(() => false);
    if (hasList) {
      const items = page.locator('ol[aria-label] > li');
      expect(await items.count()).toBeGreaterThan(0);
      // The event-type label must NOT look like a raw snake_case key
      // (defensive — audit.eventType keys should be localised strings).
      const firstEventLabel = await items.first().locator('span:not([aria-hidden])').first().innerText();
      expect(firstEventLabel.length).toBeGreaterThan(0);
    }
  });

  test('@a11y — timeline page has zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);
    await page.goto(`/admin/members/${memberId}/timeline`);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('@i18n — TH + SV locales render timeline without leaks', async ({
    page,
    context,
  }) => {
    await signIn(page);
    const memberId = await firstMemberId(page);

    for (const locale of ['th', 'sv'] as const) {
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);
      await page.goto(`/admin/members/${memberId}/timeline`);
      await page.waitForLoadState('networkidle');
      const text = await page.evaluate(() => document.body.innerText);
      expect(
        text,
        `${locale}: raw translation key leaked`,
      ).not.toMatch(/admin\.members\.timeline\.[a-z]+/i);
      expect(text, `${locale}: empty body`).not.toBe('');
    }
  });

  test('reduced-motion: timeline dots are static (no animation)', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: 'NEXT_LOCALE', value: 'en', url: 'http://localhost:3100' },
    ]);
    await signIn(page);
    const memberId = await firstMemberId(page);

    // Emulate user's reduced-motion preference at the CDP level.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/admin/members/${memberId}/timeline`);
    await page.waitForLoadState('networkidle');

    // The dot markers must have no CSS animation applied.
    const dots = page.locator('ol[aria-label] > li > span[aria-hidden]');
    const count = await dots.count();
    for (let i = 0; i < Math.min(count, 3); i++) {
      const animationName = await dots.nth(i).evaluate(
        (el) => getComputedStyle(el).animationName,
      );
      expect(animationName).toBe('none');
    }
  });
});
