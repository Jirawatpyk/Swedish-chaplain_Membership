/**
 * T065 — E2E: F4 SC-010 typography scale consistency.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const EXPECTED_H1_PX = 30; // 1.875rem
const EXPECTED_H2_PX = 24; // 1.5rem
const EXPECTED_H3_PX = 20; // 1.25rem
const EXPECTED_H4_PX = 18; // 1.125rem

test.describe('F4 SC-010 — typography scale @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('h1–h4 computed font-size matches FR-017 tokens', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    const pages = ['/admin', '/admin/users', '/admin/plans', '/admin/settings/invoicing'];
    for (const path of pages) {
      await page.goto(path);
      // Wait for network idle so the page (not loading.tsx skeleton's h1)
      // is what we measure — measuring during the loading phase returns
      // NaN because the skeleton h1 has display:none until hydrated.
      await page.waitForLoadState('networkidle');
      const h1 = page.getByRole('heading', { level: 1 });
      if (await h1.count()) {
        await h1.first().waitFor({ state: 'visible', timeout: 5_000 });
        const size = await h1
          .first()
          .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
        expect(size, `${path} h1`).toBeCloseTo(EXPECTED_H1_PX, 0);
      }

      // SC-010 literal: every h2/h3/h4 on a migrated page MUST either carry
      // a .text-h{N} utility that resolves to the FR-017 token or be
      // explicitly opted out via .text-caption (small section labels).
      // Anything else is a regression — silently skipping unclassed
      // headings (the round-1 behavior) hid three stale h2s on plan-detail.
      for (const [level, expected] of [
        [2, EXPECTED_H2_PX],
        [3, EXPECTED_H3_PX],
        [4, EXPECTED_H4_PX],
      ] as const) {
        const headings = page.getByRole('heading', { level });
        const count = await headings.count();
        for (let i = 0; i < count; i++) {
          const el = headings.nth(i);
          // Skip headings rendered inside dialog/popover portals or
          // screen-reader-only labels — they inherit their own type
          // scale from the primitive and are not page-level headings.
          const { className, inPortal, isSrOnly } = await el.evaluate((node) => {
            const parent = node.closest('.sr-only, [aria-hidden="true"]');
            return {
              className: node.className,
              inPortal: node.closest(
                '[role="dialog"],[role="alertdialog"],[data-slot="popover-content"],[data-slot="dropdown-menu-content"]',
              ) !== null,
              isSrOnly: parent !== null || node.className.includes('sr-only'),
            };
          });
          if (inPortal || isSrOnly) continue;
          const hasHeadingToken = className.includes(`text-h${level}`);
          const hasCaptionOptOut = className.includes('text-caption');
          expect(
            hasHeadingToken || hasCaptionOptOut,
            `${path} h${level} must use .text-h${level} (or .text-caption for small labels). ` +
              `Actual className: "${className}"`,
          ).toBe(true);
          if (hasHeadingToken) {
            const size = await el.evaluate((node) =>
              parseFloat(getComputedStyle(node).fontSize),
            );
            expect(size, `${path} h${level} font-size`).toBeCloseTo(expected, 0);
          }
        }
      }
    }
  });
});
