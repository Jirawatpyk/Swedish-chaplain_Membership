/**
 * 060-member-portal-d4 (Task 5) — /portal/invoices mobile card-view E2E + @a11y.
 *
 * D4 dual-renders the invoice list: a stacked CARD list below `md` (768px)
 * and the 7-column desktop TABLE at `≥ md`. This spec locks the breakpoint
 * contract + the "no horizontal scroll at mobile widths" guarantee (the
 * whole point of the card view — §9/§15) + a WCAG 2.1 AA scan.
 *
 * Requires E2E_MEMBER_* in .env.local. Run:
 *   pnpm test:e2e --grep "invoices mobile card" --workers=1
 * (ALWAYS `--workers=1` per project memory — default 3 hangs the workstation.)
 *
 * Local-noise note (project memory `reference_e2e_perf_gates_preview_only`):
 * local dev e2e has EXPECTED 320px target-size a11y noise; the AUTHORITATIVE
 * a11y run is the preview deploy. `runAxeScan` fails only on serious+critical
 * so transient moderate/target-size noise does not flake the gate, while a
 * real structural a11y regression (missing heading, unlabelled control) still
 * fails it.
 *
 * Card-content assertions (card visible, has doc-link/badge/total/action) are
 * gated on `E2E_MEMBER_HAS_INVOICES` because an empty-state member renders
 * NEITHER the table NOR the cards. The no-horizontal-scroll + axe assertions
 * run unconditionally — they must hold for the empty state too.
 */
import { expect, test } from '../fixtures';
import { runAxeScan } from '../helpers/axe-scan';
import { signInAsMember } from '../helpers/member-session';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

const EXPECTS_ROWS =
  process.env.E2E_MEMBER_HAS_INVOICES === '1' ||
  process.env.E2E_MEMBER_HAS_INVOICES === 'true';

const MOBILE_VIEWPORTS = [
  { width: 375, height: 812, label: 'iPhone X' },
  { width: 320, height: 568, label: 'iPhone SE (narrowest)' },
] as const;

async function hasHorizontalScroll(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
}

test.describe('F4 portal /portal/invoices mobile card-view (D4) @a11y @f4', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');

  for (const vp of MOBILE_VIEWPORTS) {
    test(`${vp.width}px — cards shown, table hidden, no horizontal scroll, axe clean`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await signInAsMember(page);
      await page.goto('/portal/invoices');
      await page.waitForLoadState('networkidle');

      // The desktop table (role=table, aria-label "Invoices") is hidden via
      // `hidden md:block` at mobile widths.
      const table = page.getByRole('table');
      await expect(table).toBeHidden();

      // No horizontal scroll at this width — the card list must wrap, never
      // overflow (the core reason the card view exists).
      expect(
        await hasHorizontalScroll(page),
        `${vp.label}: document must not scroll horizontally at ${vp.width}px`,
      ).toBe(false);

      if (EXPECTS_ROWS) {
        const cardList = page.getByTestId('portal-invoice-card-list');
        await expect(cardList).toBeVisible();

        // Every card carries a doc-number link → detail (drafts included).
        await expect(
          cardList
            .getByRole('listitem')
            .first()
            .getByRole('link', { name: /view invoice|ดูใบแจ้งหนี้|visa faktura/i })
            .first(),
        ).toBeVisible();

        // The confirmed mockup is the ISSUED/PAID card shape (a draft shows
        // `—` for total + no actions). Target a card that has a `"<amount> THB"`
        // total (`formatSatangThb` suffix style) to verify the full anatomy —
        // total prominence + the inline action row — independent of seed order.
        const totalLine = cardList.getByText(/\bTHB\b/).first();
        await expect(totalLine).toBeVisible();
        const issuedCard = cardList
          .getByRole('listitem')
          .filter({ has: page.getByText(/\bTHB\b/) })
          .first();

        // At least one action affordance (download / receipt / resend).
        const actions = issuedCard.locator(
          'button[data-testid^="portal-pdf-download"], button[aria-label*="invoice" i], button[aria-label*="receipt" i], button[aria-label*="email" i]',
        );
        expect(await actions.count()).toBeGreaterThan(0);
      }

      await runAxeScan(page, test.info());
    });
  }

  test('1280px — desktop table shown, mobile card list hidden', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAsMember(page);
    await page.goto('/portal/invoices');
    await page.waitForLoadState('networkidle');

    // The card list is hidden via `md:hidden` at desktop widths.
    await expect(page.getByTestId('portal-invoice-card-list')).toBeHidden();

    if (EXPECTS_ROWS) {
      await expect(page.getByRole('table')).toBeVisible();
    }
  });
});
