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

  // R50 (2026-10-16): at a 32px default font the title's no-wrap document
  // number was 419px wide, so the page laid out 435px wide at 390 and the
  // fixed action bar slid partly off screen (WCAG 1.4.4 / 1.4.10).
  test('at a 32px default font the page still fits 390px wide', async ({ page, baseURL }) => {
    await signInAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.setFontSizes', { fontSizes: { standard: 32, fixed: 32 } });
    for (const locale of LOCALES) {
      await page.context().addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL! }]);
      await page.goto(`/admin/invoices/${INVOICE_ID}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      const m = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      expect(m.innerWidth, `${locale}: the page lays out at the screen's width`).toBe(390);
      expect(m.scrollWidth, `${locale}: nothing scrolls sideways`).toBeLessThanOrEqual(390);
    }
  });

  // R48 still holds: at the default size the number is never split at its
  // hyphens — it sits on one line, the line after "Invoice". The number is an
  // inline box, which reports ONE client rect however many lines it wraps to,
  // so the check is its height against one line of the heading.
  test('at 320px and the default font the document number stays on one line', async ({ page }) => {
    await signInAsAdmin(page);
    await page.setViewportSize({ width: 320, height: 727 });
    await page.goto(`/admin/invoices/${INVOICE_ID}`);
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    const m = await h1.evaluate((el) => {
      const span = [...el.querySelectorAll('span')].find((s) => /^[A-Z]{2}-\d{4}-\d+$/.test(s.textContent ?? ''));
      if (!span) return null;
      return { height: span.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) };
    });
    expect(m, 'the heading holds the document number in its own element').not.toBeNull();
    expect(m!.height, 'the number is one line tall').toBeLessThanOrEqual(m!.line * 1.2);
  });
});
