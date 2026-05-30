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
    // Wait for the LOADED benefit card (past its Suspense skeleton) before the
    // axe scan — scanning the shimmer races a mid-render state and flakes (F9-QA-03).
    await expect(page.getByTestId('benefit-usage-card')).toBeVisible({ timeout: 15_000 });
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
    // Settle past the Suspense skeleton before scanning (F9-QA-03 flake fix).
    await expect(page.getByTestId('benefit-usage-card')).toBeVisible({ timeout: 15_000 });
    await expectNoAxeViolations(page, '/portal/benefits');
  });

  // F9 US5 — staff directory (search filters, results table, generate controls,
  // recent-exports). FR-035 / SC-010 WCAG 2.1 AA on the directory surface.
  test('staff directory (/admin/directory)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/directory');
    await expect(
      page.getByRole('heading', { name: 'Member directory', level: 1 }),
    ).toBeVisible();
    // Scope to the directory table by its caption — the page also renders a
    // "Recently generated exports" table once any export job exists, which makes
    // a bare getByRole('table') ambiguous (strict-mode violation).
    await expect(
      page.getByRole('table', { name: /members and their directory/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expectNoAxeViolations(page, '/admin/directory');
  });

  // F9 US5 — member self-service directory settings (listed switch, per-field
  // visibility checkboxes, metadata inputs, logo control). FR-025/FR-035.
  test('member directory settings (/portal/profile/directory)', async ({ page }) => {
    if (!MEMBER_EMAIL) {
      throw new Error('E2E_MEMBER_EMAIL missing — set it in .env.local before running this suite.');
    }
    await signInAsMember(page);
    await page.goto('/portal/profile/directory');
    await expect(
      page.getByRole('heading', { name: 'Directory listing', level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/portal/profile/directory');
  });

  // F9 US6 — member GDPR self-service data export (request button, status
  // table, download links). FR-029/FR-035 WCAG 2.1 AA.
  test('member data export (/portal/account/data-export)', async ({ page }) => {
    if (!MEMBER_EMAIL) {
      throw new Error('E2E_MEMBER_EMAIL missing — set it in .env.local before running this suite.');
    }
    await signInAsMember(page);
    await page.goto('/portal/account/data-export');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /request my data export/i }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/portal/account/data-export');
  });

  // F9 US6 — admin member-detail page incl. the on-behalf GDPR card (FR-031).
  // FULL-PAGE scan: the GDPR card is the US6 addition, but the verify pass also
  // surfaced + fixed 2 pre-existing violations on this F3/F4 page (invoices-
  // section amber contrast → amber-700; member description/notes <dt>/<dd>
  // wrapped in <dl>), so the whole page now meets WCAG 2.1 AA.
  test('admin member detail GDPR card (/admin/members/[id])', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/members');
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.waitFor({ timeout: 15_000 });
    const href = await firstRow.locator('a').first().getAttribute('href');
    const memberId = href?.match(/\/admin\/members\/([0-9a-f-]+)/)?.[1];
    if (!memberId) throw new Error('No member rows — seed required for a11y scan');
    await page.goto(`/admin/members/${memberId}`);
    await expect(
      page.locator('[data-testid="member-data-export-card"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expectNoAxeViolations(page, '/admin/members/[id] (detail + GDPR card)');
  });
});
