/**
 * T097 (F9 US1 / a11y) — `@a11y` axe-core scan of the F9 dashboard surfaces.
 *
 * Runs `@axe-core/playwright` (WCAG 2.0/2.1 A + AA) on the operations dashboard
 * and the members list (engagement column), failing on serious/critical
 * violations. Gated on `FEATURE_F9_DASHBOARD=true` + E2E admin creds.
 *
 * Run with `pnpm test:e2e --grep "@a11y" --workers=1`.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsMember } from './helpers/member-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const F9_ENABLED = process.env.FEATURE_F9_DASHBOARD === 'true';

async function expectNoAxeViolations(page: Page, surface: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const seriousOrWorse = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  if (seriousOrWorse.length > 0) {
    console.error(
      `[axe ${surface}] ${seriousOrWorse.length} serious/critical violations:`,
      JSON.stringify(seriousOrWorse, null, 2),
    );
  }
  expect(
    seriousOrWorse,
    `${surface}: serious/critical axe violations`,
  ).toHaveLength(0);
}

test.describe('@a11y T097 — F9 dashboard axe-core scan', () => {
  // Fail-hard gating (not test.skip) — a missing flag/creds must not let an
  // a11y run masquerade as green ("skip is not pass"). Matches f9-dashboard.spec.
  test.beforeAll(() => {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      throw new Error(
        'E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD missing — set them in .env.local before running this suite.',
      );
    }
    if (!F9_ENABLED) {
      throw new Error(
        'FEATURE_F9_DASHBOARD=false — set FEATURE_F9_DASHBOARD=true in .env.local before running this suite.',
      );
    }
  });

  test('operations dashboard (/admin)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expectNoAxeViolations(page, '/admin (dashboard)');
  });

  test('members list with engagement column (/admin/members)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/members');
    await page.waitForLoadState('domcontentloaded');
    // Wait for the table (engagement column) to render before scanning.
    await expect(page.getByRole('columnheader', { name: /engagement/i })).toBeVisible({
      timeout: 15_000,
    });
    await expectNoAxeViolations(page, '/admin/members (engagement column)');
  });

  // F9 US4 — benefit usage card (progress bars, active badges, under-use
  // warning contrast). Scans a real member's staff benefit view.
  test('member benefit view (/admin/members/[id]/benefits)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/members');
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.waitFor({ timeout: 15_000 });
    const href = await firstRow.locator('a').first().getAttribute('href');
    const memberId = href?.match(/\/admin\/members\/([0-9a-f-]+)/)?.[1];
    if (!memberId) throw new Error('No member rows — seed required for a11y scan');
    await page.goto(`/admin/members/${memberId}/benefits`);
    await expect(
      page.getByRole('heading', { name: 'Member benefits', level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/admin/members/[id]/benefits');
  });

  // F9 US4 — the MEMBER-facing counterpart (same BenefitUsageCard). FR-035
  // requires both surfaces to meet WCAG 2.1 AA.
  test('member benefit view (/portal/benefits)', async ({ page }) => {
    if (!MEMBER_EMAIL) {
      throw new Error('E2E_MEMBER_EMAIL missing — set it in .env.local before running this suite.');
    }
    await signInAsMember(page);
    await page.goto('/portal/benefits');
    await expect(page.getByRole('heading', { name: 'Benefits', level: 1 })).toBeVisible();
    await expectNoAxeViolations(page, '/portal/benefits');
  });
});
