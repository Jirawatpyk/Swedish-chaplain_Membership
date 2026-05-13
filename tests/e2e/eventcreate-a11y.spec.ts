/**
 * T055 — F6 events list + detail axe-core a11y scan.
 *
 * Spec authority: specs/012-eventcreate-integration/checklists/ux.md (CHK0xx
 * — WCAG 2.1 AA scan via @axe-core/playwright) + Constitution VI (Inclusive UX).
 *
 * Surfaces covered:
 *   - /admin/events                  (list page)
 *   - /admin/events/[eventId]        (detail page — at least one seeded event)
 *
 * Fails on `serious` or `critical` axe violations only — `minor` /
 * `moderate` get logged but do not fail the suite (matches F7 +
 * F8 a11y convention).
 *
 * RED reason: pages do not exist yet (T065 + T066). Navigation 404s,
 * axe runs against the 404 page and may not surface the F6-specific
 * issues — the failing `expect(...).toBeVisible()` precondition is the
 * RED marker.
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD; skip at runtime when
 * absent (CI-skip pattern).
 *
 * Run with: pnpm test:e2e --grep "@a11y.*F6" --workers=1
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ timeout: 180_000 });

async function expectNoAxeViolations(
  page: Page,
  surface: string,
): Promise<void> {
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

test.describe('@a11y T055 — F6 events list+detail axe-core scan', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin a11y scans',
  );

  test('admin events list (/admin/events)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    // Ensure the page rendered the F6 list surface (heading exists)
    // before scanning — guards against scanning a 404 page during
    // RED phase.
    await expect(
      page.getByRole('heading', { name: /events/i, level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/admin/events');
  });

  test('admin event detail (/admin/events/[eventId])', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const firstRowLink = page.getByRole('table').getByRole('link').first();
    if (!(await firstRowLink.isVisible().catch(() => false))) {
      test.skip(
        true,
        'No seeded F6 events available — detail page a11y scan needs at least one row',
      );
      return;
    }
    await firstRowLink.click();
    await page.waitForURL(/\/admin\/events\/[^/]+$/);
    await page.waitForLoadState('domcontentloaded');
    await expectNoAxeViolations(page, '/admin/events/[eventId]');
  });

  /**
   * D2 verify-fix (2026-05-13) — wizard page a11y scan covering Phase 5
   * US3 surface. SC-010 requires WCAG 2.1 AA across all admin surfaces;
   * the wizard introduces complex interactive primitives (one-time
   * reveal panel + checkbox gate + Stepper + walkthrough list with
   * Next/Image elements + confirmation AlertDialog for rotate +
   * Switch toggle on recent deliveries) that were not covered by the
   * Phase 4 list/detail scans above.
   */
  test('admin integration wizard (/admin/integrations/eventcreate)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');
    // Guard against scanning a 404 page — wait until the wizard's H1
    // is visible before the axe scan kicks off.
    await expect(
      page.getByRole('heading', { level: 1 }),
    ).toBeVisible();
    await expectNoAxeViolations(page, '/admin/integrations/eventcreate');
  });
});
