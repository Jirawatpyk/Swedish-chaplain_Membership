/**
 * T147 — F5 PaySheet drawer interaction E2E.
 *
 * @f5 @e2e
 *
 * Spec authority:
 *   - spec.md FR-025 (drawer pattern; deep-link via `?pay=1`)
 *   - plan.md § Q4 (Sheet drawer chosen over Stripe Checkout redirect
 *     to preserve portal context)
 *   - plan.md § UX Reduced-motion matrix
 *
 * Asserts:
 *   1. `?pay=1` deep-link auto-opens the drawer on page load.
 *   2. Pressing Escape (or clicking the close button) closes the drawer
 *      AND removes `?pay=1` from the URL (browser-history sync).
 *   3. At `< sm` viewport the drawer takes the full screen (mobile
 *      full-screen variant — UX rule from `docs/ux-standards.md` § 18).
 *   4. Without the deep-link, the drawer is closed on initial load
 *      (no involuntary modal flash on portal navigation).
 *   5. Tab-key focus is trapped inside the drawer when open (a11y FR
 *      from spec.md US1 acceptance scenario 5).
 *   6. Reduced-motion variant: drawer transition is ≤ 80ms when
 *      `prefers-reduced-motion: reduce` is set (cross-checked with
 *      payment-a11y.spec.ts).
 */
import { memberTest as test, expect } from './helpers/member-session';

const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;
const isCi = process.env.CI === 'true' || process.env.CI === '1';

test.describe('PaySheet drawer interactions @f5 @e2e (T147)', () => {
  if (!ISSUED_INVOICE_ID) {
    if (isCi) {
      throw new Error('[T147 CI gate] E2E_ISSUED_INVOICE_ID must be set in CI.');
    }
    test.skip(true, 'E2E_ISSUED_INVOICE_ID missing — local skip.');
  }

  test('?pay=1 deep-link auto-opens the drawer', async ({ page }) => {
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    const sheet = page.locator('[data-testid="pay-sheet-content"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });
    await expect(sheet).toBeVisible();
  });

  test('without ?pay=1 the drawer is closed on initial load', async ({
    page,
  }) => {
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');
    const sheet = page.locator('[data-testid="pay-sheet-content"]');
    await expect(
      sheet,
      'drawer must NOT auto-open without the deep-link',
    ).toBeHidden();
  });

  test('Escape key closes the drawer and removes ?pay=1 from URL', async ({
    page,
  }) => {
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    const sheet = page.locator('[data-testid="pay-sheet-content"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });

    // Press Escape from the drawer body — focus should already be
    // inside the drawer (radix-ui Dialog default behaviour).
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden', timeout: 5_000 });

    // URL should no longer contain ?pay=1 — browser-history sync
    // (spec FR-025: Escape-close MUST clean the URL so a back-button
    // reload doesn't immediately re-open).
    const url = page.url();
    expect(
      url,
      `URL after Escape-close MUST drop ?pay=1; got ${url}`,
    ).not.toMatch(/[?&]pay=1\b/);
  });

  test('Close button closes the drawer', async ({ page }) => {
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    const sheet = page.locator('[data-testid="pay-sheet-content"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });

    const closeBtn = page.locator('[data-testid="pay-sheet-close"]');
    await closeBtn.click();
    await sheet.waitFor({ state: 'hidden', timeout: 5_000 });
  });

  test('mobile full-screen variant at < sm breakpoint', async ({ page }) => {
    // sm breakpoint in Tailwind v4 = 640px. Use 375 (iPhone-ish) to
    // ensure we're well below.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    const sheet = page.locator('[data-testid="pay-sheet-content"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });

    // At < sm, the drawer must occupy the full viewport width (or close
    // to it — allow a few px tolerance for body scrollbars / iframe
    // overlays).
    const dimensions = await sheet.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        sheetWidth: rect.width,
        viewportWidth: window.innerWidth,
        sheetLeft: rect.left,
      };
    });
    expect(
      dimensions.sheetWidth,
      `drawer width ${dimensions.sheetWidth}px should ≈ viewport ${dimensions.viewportWidth}px on mobile`,
    ).toBeGreaterThan(dimensions.viewportWidth - 16);
    // Drawer should anchor at left=0 (full-screen) on mobile, not
    // float inset like the desktop sheet.
    expect(dimensions.sheetLeft).toBeLessThanOrEqual(8);
  });

  test('focus trap: Tab cycles within drawer when open', async ({ page }) => {
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    const sheet = page.locator('[data-testid="pay-sheet-content"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Tab through up to 30 elements; assert focused element NEVER
    // escapes the drawer. radix-ui Dialog guarantees this; the test
    // is a regression guard against a future refactor that swaps the
    // drawer primitive without preserving focus-trap semantics.
    for (let i = 0; i < 30; i += 1) {
      const focusedInDrawer = await page.evaluate(() => {
        const drawer = document.querySelector(
          '[data-testid="pay-sheet-content"]',
        );
        if (!drawer) return false;
        const active = document.activeElement;
        return active ? drawer.contains(active) : false;
      });
      expect(
        focusedInDrawer,
        `Tab ${i + 1}: focus escaped the drawer (focus-trap broken)`,
      ).toBe(true);
      await page.keyboard.press('Tab');
    }
  });

  test('reduced-motion: drawer transition ≤ 80ms', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}?pay=1`);
    const sheet = page.locator('[data-testid="pay-sheet-content"]');
    await sheet.waitFor({ state: 'visible', timeout: 10_000 });

    const transitionDuration = await sheet.evaluate((el) =>
      window.getComputedStyle(el).transitionDuration,
    );
    const match = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(transitionDuration);
    if (match) {
      const num = Number(match[1]);
      const unit = match[2];
      const ms = unit === 's' ? num * 1000 : num;
      expect(
        ms,
        `reduced-motion drawer transition ${transitionDuration} > 80ms`,
      ).toBeLessThanOrEqual(80);
    }
    // Empty/unset transition-duration is also acceptable (no animation).
  });
});
