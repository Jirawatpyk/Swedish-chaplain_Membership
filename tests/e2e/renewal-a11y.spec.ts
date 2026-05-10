/**
 * F8 Phase 10 · T267 — Renewal a11y axe-core scan.
 *
 * Runs `@axe-core/playwright` on every F8 user-facing surface in
 * BOTH light + dark themes + reduced-motion emulation. Fails on
 * serious or critical WCAG 2.1 AA violations. Mirrors F7 +
 * F4 a11y-spec patterns (broadcast-axe.spec.ts /
 * invoice-admin-a11y.spec.ts).
 *
 * Surfaces covered (per spec.md):
 *   - /admin/renewals                        (US1 pipeline dashboard)
 *   - /admin/renewals/[cycleId]              (US1 cycle detail)
 *   - /admin/renewals/tasks                  (US6 escalation queue)
 *   - /admin/renewals/tier-upgrades          (US5 tier-upgrade queue)
 *   - /portal/renewal/[memberId]             (US3 self-service entry)
 *   - /portal/preferences/renewals           (US3 reminder preferences)
 *
 * Tests skip at runtime when E2E_ADMIN_EMAIL / E2E_MEMBER_EMAIL are
 * absent (CI-skip pattern matching the rest of F8 e2e suite).
 *
 * Run:
 *   pnpm test:e2e --workers=1 --grep "@a11y T267"
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsMember } from './helpers/member-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const E2E_RENEWAL_CYCLE_ID = process.env.E2E_RENEWAL_CYCLE_ID;
const E2E_MEMBER_ID = process.env.E2E_MEMBER_ID;

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
  expect(seriousOrWorse, `${surface}: serious/critical axe violations`).toHaveLength(0);
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  // R4 review M3 fix: corrected mechanism description.
  // next-themes' pre-hydration script reads `localStorage.theme` and
  // sets the `class` attribute on `<html>` (not `data-theme` —
  // ThemeProvider is configured `attribute="class"` per
  // src/app/layout.tsx). The script runs before React hydrates so
  // axe scans the themed DOM.
  await page.addInitScript((t) => {
    window.localStorage.setItem('theme', t);
  }, theme);
}

test.describe('@a11y T267 — F8 axe-core scan', () => {
  test.describe('admin surfaces (gated on E2E_ADMIN_*)', () => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin a11y scans',
    );

    for (const theme of ['light', 'dark'] as const) {
      test(`/admin/renewals (${theme})`, async ({ page }) => {
        await setTheme(page, theme);
        await signInAsAdmin(page);
        await page.goto('/admin/renewals');
        await page.waitForLoadState('domcontentloaded');
        await expectNoAxeViolations(page, `/admin/renewals (${theme})`);
      });

      test(`/admin/renewals/tasks (${theme})`, async ({ page }) => {
        await setTheme(page, theme);
        await signInAsAdmin(page);
        await page.goto('/admin/renewals/tasks');
        await page.waitForLoadState('domcontentloaded');
        await expectNoAxeViolations(page, `/admin/renewals/tasks (${theme})`);
      });

      test(`/admin/renewals/tier-upgrades (${theme})`, async ({ page }) => {
        await setTheme(page, theme);
        await signInAsAdmin(page);
        await page.goto('/admin/renewals/tier-upgrades');
        await page.waitForLoadState('domcontentloaded');
        await expectNoAxeViolations(page, `/admin/renewals/tier-upgrades (${theme})`);
      });

      test(`/admin/renewals/[cycleId] (${theme})`, async ({ page }) => {
        test.skip(
          !E2E_RENEWAL_CYCLE_ID,
          'Set E2E_RENEWAL_CYCLE_ID to run cycle-detail a11y scan',
        );
        await setTheme(page, theme);
        await signInAsAdmin(page);
        await page.goto(`/admin/renewals/${E2E_RENEWAL_CYCLE_ID}`);
        await page.waitForLoadState('domcontentloaded');
        await expectNoAxeViolations(
          page,
          `/admin/renewals/[cycleId] (${theme})`,
        );
      });
    }

    test('admin pipeline with prefers-reduced-motion', async ({ browser }) => {
      // axe doesn't directly assert reduced-motion behaviour, but the
      // emulated context lets us verify pages don't ship motion-only
      // affordances + the DOM still passes WCAG 2.1 AA structure.
      const ctx = await browser.newContext({ reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      try {
        await signInAsAdmin(page);
        await page.goto('/admin/renewals');
        await page.waitForLoadState('domcontentloaded');
        await expectNoAxeViolations(
          page,
          '/admin/renewals (reduced-motion)',
        );
      } finally {
        await ctx.close();
      }
    });
  });

  test.describe('member surfaces (gated on E2E_MEMBER_*)', () => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'Set E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD to run member a11y scans',
    );

    for (const theme of ['light', 'dark'] as const) {
      test(`/portal/preferences/renewals (${theme})`, async ({ page }) => {
        await setTheme(page, theme);
        await signInAsMember(page);
        await page.goto('/portal/preferences/renewals');
        await page.waitForLoadState('domcontentloaded');
        await expectNoAxeViolations(
          page,
          `/portal/preferences/renewals (${theme})`,
        );
      });

      test(`/portal/renewal/[memberId] (${theme})`, async ({ page }) => {
        test.skip(
          !E2E_MEMBER_ID,
          'Set E2E_MEMBER_ID to run member self-service-renewal a11y scan',
        );
        await setTheme(page, theme);
        await signInAsMember(page);
        await page.goto(`/portal/renewal/${E2E_MEMBER_ID}`);
        await page.waitForLoadState('domcontentloaded');
        await expectNoAxeViolations(
          page,
          `/portal/renewal/[memberId] (${theme})`,
        );
      });
    }
  });
});
