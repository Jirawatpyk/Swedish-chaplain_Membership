/**
 * Spec 122 US8b — the invoice page's phone action bar (below 640px the header
 * actions become a bar fixed to the bottom of the screen; board
 * `Admin-invoice-issued-mobile`: the total on top, then the actions, the main
 * one growing to fill the row BESIDE the ⋯ menu).
 *
 * R48 (2026-10-15) measured it at 393 wide: on a paid invoice the admin's two
 * actions filled the row and pushed the ⋯ onto a third line of its own (a
 * 145px bar), and a manager's lone ⋯ sat bare at the left under the total (a
 * 93px bar). These cases pin the layout the UX review asked for, by geometry:
 * a class name cannot show where a flex row wraps.
 *
 * Since #150 the bar is AURA's: the header's own actions
 * (`PageHeader actionsBarBelow="sm"`), with the total as the bar's status.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { signInAsAdmin } from '../helpers/admin-session';
import { signInAsManager } from '../helpers/manager-session';

const INVOICE_ID = process.env.E2E_PAID_ONLINE_INVOICE_ID;
const WIDTHS = [393, 320] as const;

type Box = { top: number; bottom: number; left: number; right: number; height: number };

async function measureBar(page: Page) {
  return page.evaluate(() => {
    const box = (e: Element): Box => {
      const r = e.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
    };
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const bar = document.querySelector('[data-slot="page-header"] > .aura-page-header__actions');
    if (!bar) return null;
    const menu = bar.querySelector('button[data-slot="invoice-more-menu"]');
    const summary = bar.querySelector('.aura-page-header__status');
    // The actions: every visible button-like control in the bar except the ⋯.
    const actions = Array.from(bar.querySelectorAll('a, button'))
      .filter((e) => shown(e) && e !== menu)
      .map((e) => ({ ...box(e), clipped: e.scrollWidth > e.clientWidth + 1, text: (e.textContent ?? '').trim() }));
    return {
      viewport: innerWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      bar: box(bar),
      menu: menu ? box(menu) : null,
      summary: summary ? box(summary) : null,
      actions,
    };
  });
}

async function openInvoiceAt(page: Page, width: number): Promise<NonNullable<Awaited<ReturnType<typeof measureBar>>>> {
  await page.setViewportSize({ width, height: 727 });
  await page.goto(`/admin/invoices/${INVOICE_ID}`);
  await expect(page.locator('[data-slot="page-header"] > .aura-page-header__actions')).toBeVisible();
  // The bar is laid out by the client (its fixed position follows hydration).
  await page.waitForLoadState('networkidle');
  const m = await measureBar(page);
  expect(m, 'the phone action bar renders').not.toBeNull();
  // A phone browser WIDENS its layout viewport to fit content wider than the
  // screen (and scales the page down), so `scrollWidth - innerWidth` stays 0
  // and an overflow hides: in SV at 320 the page laid out 345 wide and the
  // fixed bar sat below the visible screen (R48). Compare to the set width.
  expect(m!.viewport, `${width}px: the page lays out at the screen's width`).toBe(width);
  return m!;
}

test.describe('invoice detail — phone action bar layout @a11y', () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, 'the bar exists below 640px on a touch phone; the mobile projects cover it');
    test.skip(!INVOICE_ID, 'E2E_PAID_ONLINE_INVOICE_ID is set by global setup (the paid-online fixture invoice)');
  });

  test('admin, paid invoice: the ⋯ stays on the actions row, at its end, and no label is clipped', async ({ page }) => {
    await signInAsAdmin(page);
    for (const width of WIDTHS) {
      const m = await openInvoiceAt(page, width);
      expect(m.actions.length, `${width}px: the paid invoice offers its main actions`).toBeGreaterThan(0);
      const first = m.actions[0]!;
      // Centred on the first action, not top-aligned: beside a two-line label
      // a top-aligned ⋯ hangs off the row's top edge (decided with the
      // maintainer and asked of AURA in #150, 15 Oct).
      const menuMid = (m.menu!.top + m.menu!.bottom) / 2;
      const firstMid = (first.top + first.bottom) / 2;
      expect(Math.abs(menuMid - firstMid), `${width}px: ⋯ centre vs first action centre`).toBeLessThanOrEqual(1);
      expect(m.menu!.right, `${width}px: ⋯ ends the row`).toBeGreaterThanOrEqual(Math.max(...m.actions.map((a) => a.right)));
      expect(m.bar.height, `${width}px: bar height`).toBeLessThanOrEqual(124);
      for (const a of m.actions) expect(a.clipped, `${width}px: "${a.text}" is clipped`).toBe(false);
      expect(m.pageOverflow, `${width}px: page scrolls sideways`).toBeLessThanOrEqual(0);
    }
  });

  test('manager, paid invoice: the lone ⋯ sits beside the total, at the right', async ({ page }) => {
    await signInAsManager(page);
    for (const width of WIDTHS) {
      const m = await openInvoiceAt(page, width);
      expect(m.actions, `${width}px: a manager has no main action here`).toHaveLength(0);
      const menuMid = (m.menu!.top + m.menu!.bottom) / 2;
      const summaryMid = (m.summary!.top + m.summary!.bottom) / 2;
      expect(Math.abs(menuMid - summaryMid), `${width}px: ⋯ on the total's row`).toBeLessThanOrEqual(4);
      // AURA's bar is inset from the screen edges; the ⋯ ends at its padding.
      expect(m.bar.right - m.menu!.right, `${width}px: ⋯ at the bar's right edge`).toBeLessThanOrEqual(16);
      expect(m.bar.height, `${width}px: bar height`).toBeLessThanOrEqual(76);
      expect(m.pageOverflow, `${width}px: page scrolls sideways`).toBeLessThanOrEqual(0);
    }
  });
  // WCAG 2.4.11: the bar is fixed, so a control the keyboard reaches must not
  // sit wholly behind it. AURA pads the page end and sets scroll-padding-bottom
  // (#150); this pins that on the page, Tab by Tab, skipping the bar's own
  // controls (they are inside it by design).
  test('admin, paid invoice: tabbing down the page never hides the focused control behind the bar', async ({ page }) => {
    await signInAsAdmin(page);
    await openInvoiceAt(page, 393);
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(() => {
        const bar = document.querySelector('[data-slot="page-header"] > .aura-page-header__actions');
        const el = document.activeElement;
        if (!bar || !el || el === document.body || bar.contains(el)) return null;
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) return null;
        return { top: b.top, barTop: bar.getBoundingClientRect().top, name: (el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 40) };
      });
      if (!r) continue;
      expect(r.top, `"${r.name}" is not wholly behind the bar`).toBeLessThan(r.barTop);
    }
  });

  // The labels differ most in SV and TH ("Utfärda återbetalning…"): in every
  // locale the bar fits 320px, the ⋯ stays on the actions row and no label is cut.
  test('admin, paid invoice at 320px: the bar fits and holds its row in EN, TH and SV', async ({ page, baseURL }) => {
    await signInAsAdmin(page);
    for (const locale of ['en', 'th', 'sv'] as const) {
      await page.context().addCookies([{ name: 'NEXT_LOCALE', value: locale, url: baseURL! }]);
      const m = await openInvoiceAt(page, 320);
      const first = m.actions[0]!;
      expect(Math.abs((m.menu!.top + m.menu!.bottom) / 2 - (first.top + first.bottom) / 2), `${locale}: ⋯ on the actions row`).toBeLessThanOrEqual(1);
      for (const a of m.actions) expect(a.clipped, `${locale}: "${a.text}" is clipped`).toBe(false);
      expect(m.pageOverflow, `${locale}: page scrolls sideways`).toBeLessThanOrEqual(0);
    }
  });
});
