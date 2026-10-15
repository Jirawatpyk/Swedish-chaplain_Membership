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
    const bar = document.querySelector('[data-slot="invoice-action-bar"]');
    if (!bar) return null;
    const menu = bar.querySelector('[data-slot="invoice-more-menu"] button');
    const summary = bar.querySelector('p');
    // The actions: every visible button-like control in the bar except the ⋯.
    const actions = Array.from(bar.querySelectorAll('a, button'))
      .filter((e) => shown(e) && !e.closest('[data-slot="invoice-more-menu"]'))
      .map((e) => ({ ...box(e), clipped: e.scrollWidth > e.clientWidth + 1, text: (e.textContent ?? '').trim() }));
    return {
      viewport: innerWidth,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      bar: box(bar),
      menu: menu ? { ...box(menu), borderTop: parseFloat(getComputedStyle(menu).borderTopWidth) } : null,
      summary: summary ? box(summary) : null,
      actions,
    };
  });
}

async function openInvoiceAt(page: Page, width: number): Promise<NonNullable<Awaited<ReturnType<typeof measureBar>>>> {
  await page.setViewportSize({ width, height: 727 });
  await page.goto(`/admin/invoices/${INVOICE_ID}`);
  await expect(page.locator('[data-slot="invoice-action-bar"]')).toBeVisible();
  // The bar is laid out by the client (its fixed position follows hydration).
  await page.waitForLoadState('networkidle');
  const m = await measureBar(page);
  expect(m, 'the phone action bar renders').not.toBeNull();
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
      expect(Math.abs(m.menu!.top - first.top), `${width}px: ⋯ top vs first action top`).toBeLessThanOrEqual(1);
      expect(m.menu!.right, `${width}px: ⋯ ends the row`).toBeGreaterThanOrEqual(Math.max(...m.actions.map((a) => a.right)));
      expect(m.bar.height, `${width}px: bar height`).toBeLessThanOrEqual(124);
      for (const a of m.actions) expect(a.clipped, `${width}px: "${a.text}" is clipped`).toBe(false);
      expect(m.pageOverflow, `${width}px: page scrolls sideways`).toBeLessThanOrEqual(0);
    }
  });

  test('manager, paid invoice: the lone ⋯ sits beside the total, at the right, and reads as a button', async ({ page }) => {
    await signInAsManager(page);
    for (const width of WIDTHS) {
      const m = await openInvoiceAt(page, width);
      expect(m.actions, `${width}px: a manager has no main action here`).toHaveLength(0);
      const menuMid = (m.menu!.top + m.menu!.bottom) / 2;
      const summaryMid = (m.summary!.top + m.summary!.bottom) / 2;
      expect(Math.abs(menuMid - summaryMid), `${width}px: ⋯ on the total's row`).toBeLessThanOrEqual(4);
      expect(m.viewport - m.menu!.right, `${width}px: ⋯ at the right edge`).toBeLessThanOrEqual(16);
      expect(m.menu!.borderTop, `${width}px: ⋯ has a visible boundary`).toBeGreaterThanOrEqual(1);
      expect(m.bar.height, `${width}px: bar height`).toBeLessThanOrEqual(76);
      expect(m.pageOverflow, `${width}px: page scrolls sideways`).toBeLessThanOrEqual(0);
    }
  });
});
