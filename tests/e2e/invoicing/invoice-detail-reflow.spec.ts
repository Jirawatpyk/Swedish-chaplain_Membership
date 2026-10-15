/**
 * WCAG 1.4.10 Reflow on the staff invoice page, in every locale, at 320px.
 *
 * R48 (2026-10-15): in SV the payment card's transaction-id chip
 * ("Transaktions-id: ch_…", a nowrap mono badge) was 300px wide, so the page
 * laid out 345px wide. A phone browser does not scroll that sideways: it
 * WIDENS its layout viewport and scales the page down, so `scrollWidth -
 * innerWidth` stays 0 and only `innerWidth` shows it. EN fitted, which is why
 * the EN-only suites never saw it.
 */
import { expect, test } from '../fixtures';
import { signInAsAdmin } from '../helpers/admin-session';

const INVOICE_ID = process.env.E2E_PAID_ONLINE_INVOICE_ID;
const LOCALES = ['en', 'th', 'sv'] as const;

test.describe('invoice detail — reflow at 320px in every locale @a11y', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'the layout-viewport check needs a phone browser; the mobile projects cover it');
    test.skip(!INVOICE_ID, 'E2E_PAID_ONLINE_INVOICE_ID is set by global setup (the paid-online fixture invoice)');
  });

  test('the paid-online invoice, payment card included, fits 320px wide', async ({ page, baseURL }) => {
    await signInAsAdmin(page);
    await page.setViewportSize({ width: 320, height: 727 });
    for (const locale of LOCALES) {
      await page.context().addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL! }]);
      await page.goto(`/admin/invoices/${INVOICE_ID}`);
      await expect(page.getByTestId('processor-charge-id')).toBeVisible();
      await page.waitForLoadState('networkidle');
      const m = await page.evaluate(() => ({
        innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        chipRight: Math.round(document.querySelector('[data-testid="processor-charge-id"]')!.getBoundingClientRect().right),
      }));
      expect(m.innerWidth, `${locale}: the page lays out at the screen's width`).toBe(320);
      expect(m.scrollWidth, `${locale}: nothing scrolls sideways`).toBeLessThanOrEqual(320);
      expect(m.chipRight, `${locale}: the transaction-id chip stays on screen`).toBeLessThanOrEqual(320);
    }
  });
});
