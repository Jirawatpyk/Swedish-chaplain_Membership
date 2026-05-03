/**
 * T190 (Phase 10 / a11y.md CHK055) — F7 axe-core scan.
 *
 * Runs `@axe-core/playwright` on every public-facing F7 surface +
 * fails on serious or critical violations. Tests skip at runtime
 * when E2E_MEMBER_EMAIL / E2E_ADMIN_EMAIL are absent (CI-skip
 * pattern matching the rest of the broadcast e2e suite).
 *
 * Surfaces covered (per a11y.md CHK055):
 *   - /portal/broadcasts/new       (compose form)
 *   - /admin/broadcasts            (admin queue)
 *   - /portal/benefits/e-blasts    (member quota dashboard)
 *   - /unsubscribe/v1.invalid.invalid (public unsubscribe — invalid token render)
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

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
  expect(seriousOrWorse, `${surface}: serious/critical axe violations`).toHaveLength(
    0,
  );
}

test.describe('@a11y T190 — F7 axe-core scan', () => {
  test('public unsubscribe page (invalid token render path)', async ({
    page,
  }) => {
    await page.goto('/unsubscribe/v1.invalid.invalid');
    await page.waitForLoadState('domcontentloaded');
    await expectNoAxeViolations(page, '/unsubscribe/[invalid]');
  });

  test.describe('member surfaces (gated on E2E_MEMBER_*)', () => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'Set E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD to run member-portal axe scans',
    );

    test('compose form', async ({ page }) => {
      // Sign-in helper — same pattern as broadcast-compose-and-submit.spec
      await page.goto('/portal/sign-in');
      await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
      await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL(
        (u) => {
          const p = new URL(u).pathname;
          return p.startsWith('/portal') && !p.startsWith('/portal/sign-in');
        },
        { timeout: 120_000 },
      );

      await page.goto('/portal/broadcasts/new');
      await page.waitForLoadState('domcontentloaded');
      await expectNoAxeViolations(page, '/portal/broadcasts/new');
    });

    test('member benefits page', async ({ page }) => {
      await page.goto('/portal/sign-in');
      await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
      await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL(
        (u) => {
          const p = new URL(u).pathname;
          return p.startsWith('/portal') && !p.startsWith('/portal/sign-in');
        },
        { timeout: 120_000 },
      );

      await page.goto('/portal/benefits/e-blasts');
      await page.waitForLoadState('domcontentloaded');
      await expectNoAxeViolations(page, '/portal/benefits/e-blasts');
    });
  });

  test.describe('admin surfaces (gated on E2E_ADMIN_*)', () => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin-portal axe scans',
    );

    test('admin queue', async ({ page }) => {
      await page.goto('/admin/sign-in');
      await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
      await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
      await page.getByRole('button', { name: /sign in/i }).click();
      await page.waitForURL(
        (u) => {
          const p = new URL(u).pathname;
          return p.startsWith('/admin') && !p.startsWith('/admin/sign-in');
        },
        { timeout: 120_000 },
      );

      await page.goto('/admin/broadcasts');
      await page.waitForLoadState('domcontentloaded');
      await expectNoAxeViolations(page, '/admin/broadcasts');
    });
  });
});
