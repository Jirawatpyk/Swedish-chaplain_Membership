/**
 * T137 — E2E: /admin/members/[memberId] archive + undelete flow
 * @f3 @a11y @i18n.
 *
 * Coverage:
 *   - Member detail page exposes Archive action
 *   - Archive dialog renders + has reason textarea
 *   - WCAG 2.1 AA scan via @axe-core/playwright (detail + banner)
 *   - i18n smoke: TH + SV locales render without raw translation-key
 *     leaks for `admin.members.archive.*` / `admin.members.undelete.*`
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

test.describe('members archive/undelete — F3 US7 @f3 @a11y @i18n', () => {
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

  async function firstActiveMemberId(page: Page): Promise<string> {
    // Filter to active members only so the Archive CTA is visible.
    await page.goto('/admin/members?status=active');
    await page.waitForLoadState('networkidle');
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.waitFor({ timeout: 15_000 });
    const href = await firstRow.locator('a').first().getAttribute('href');
    if (!href) throw new Error('No active member rows — seed required');
    const match = href.match(/\/admin\/members\/([0-9a-f-]+)/);
    if (!match) throw new Error(`Could not parse memberId from ${href}`);
    return match[1]!;
  }

  test('detail page renders Archive CTA for active members', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('button', { name: /archive member/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('Archive dialog opens with reason textarea + Cancel/Confirm', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);

    await page
      .getByRole('button', { name: /archive member/i })
      .first()
      .click();

    // Alert dialog surfaces
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Reason textarea is present (label points at #archive-reason)
    await expect(dialog.locator('#archive-reason')).toBeVisible();

    // Cancel dismisses the dialog
    await dialog.getByRole('button', { name: /cancel|ยกเลิก|avbryt/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('@a11y — archive flow has zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // Scan detail page first
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Open archive dialog and scan again
    await page
      .getByRole('button', { name: /archive member/i })
      .first()
      .click();
    await page.getByRole('alertdialog').waitFor({ timeout: 5_000 });

    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('@i18n — TH + SV locales render archive UI without leaks', async ({
    page,
    context,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);

    for (const locale of ['th', 'sv'] as const) {
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);
      await page.goto(`/admin/members/${memberId}`);
      await page.waitForLoadState('networkidle');
      const text = await page.evaluate(() => document.body.innerText);
      expect(
        text,
        `${locale}: archive translation key leaked`,
      ).not.toMatch(/admin\.members\.archive\.[a-z]+/i);
      expect(
        text,
        `${locale}: undelete translation key leaked`,
      ).not.toMatch(/admin\.members\.undelete\.[a-z]+/i);
    }
  });
});
