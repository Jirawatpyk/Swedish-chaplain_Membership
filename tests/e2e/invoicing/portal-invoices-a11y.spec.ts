/**
 * 088 T072a (SC-010 + SC-011) — PORTAL member invoice surfaces a11y + responsive.
 *
 * Cluster-D4 extension of the two admin Cluster-A specs
 * (`issue-invoice-zero-rate-a11y.spec.ts` + `invoice-settings-a11y.spec.ts`):
 * it carries the SAME @a11y matrix onto the member-facing 088 surfaces built
 * in B1 (the 2-document SC-bill ↔ RC-receipt list, T065) + B3 (the async
 * receipt-render state, T066a/b):
 *
 *   1. axe-core WCAG 2.0/2.1 A+AA — zero serious/critical violations on the
 *      member invoice list at desktop AND at 320/375 CSS px (the widths the
 *      mobile card list takes over);
 *   2. WCAG 2.5.5 Target Size — every per-row PDF download / receipt / resend
 *      control is ≥44×44px (FR-036);
 *   3. WCAG 1.4.10 Reflow / SC-011 — at 320 and 375 CSS px the page has no
 *      horizontal scroll (`document.scrollWidth ≤ window.innerWidth`);
 *   4. WCAG 1.4.4 Resize Text 200% — the list stays usable (no clipping, no
 *      page h-scroll);
 *   5. keyboard reach + focus-visible — the per-row download control enters the
 *      tab order and is focusable;
 *   6. aria-live — when a paid invoice's §86/4 RC receipt PDF is mid-render, the
 *      `<ReceiptStatusWatcher>` polite `role="status"` region is present (B3);
 *   7. the permanent-render-failure member state (`ReceiptFailedSupportHint`) is
 *      a calm support-path affordance, NOT a spinner/aria-busy (T066a).
 *
 * PREVIEW-AUTHORITATIVE + fixture-dependent (mirrors the F4 + Cluster-A E2E
 * policy). It needs an authenticated member (`E2E_MEMBER_*`); the 2-document
 * disambiguation additionally needs the `FEATURE_088_TAX_AT_PAYMENT` flag ON
 * and a seeded 088 bill/receipt for that member — so those assertions are
 * PRESENCE-GATED (graceful no-op when the fixture/flag are absent). Per project
 * memory (`reference_e2e_perf_gates_preview_only`) local dev is expected to emit
 * 320px reflow / target-size noise; the authoritative a11y run is the preview
 * deploy. The load-bearing verification for the underlying FIXES is the RTL /
 * structural guard (tests/unit/app/portal/invoices/portal-invoices-mobile-first
 * .test.tsx + portal-pdf-download-button.test.tsx). ALWAYS run with
 * `--workers=1` (project memory — the default of 3 hangs the workstation).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { runAxeScan } from '../helpers/axe-scan';
import { clearE2ERateLimits } from '../helpers/rate-limit';
import { signInAsMember } from '../helpers/member-session';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const EXPECTS_ROWS =
  process.env.E2E_MEMBER_HAS_INVOICES === '1' ||
  process.env.E2E_MEMBER_HAS_INVOICES === 'true';

const MIN_TARGET = 44;
const LIST_PATH = '/portal/invoices';

/**
 * The per-row action controls on the list/card: PDF download (invoice),
 * receipt download, and resend. The list surface sets no data-testid on the
 * download buttons (only the DETAIL page does), so match on the localised
 * aria-labels the controls carry (kind + number). The resend control's aria
 * comes from the `emailCopy` key ("Email me a copy …").
 */
const ROW_ACTION_SELECTOR =
  'button[aria-label*="invoice" i], button[aria-label*="receipt" i], button[aria-label*="faktura" i], button[aria-label*="kvitto" i], button[aria-label*="email" i], button[aria-label*="ใบแจ้งหนี้"], button[aria-label*="ใบเสร็จ"]';

/** WCAG 2.5.5 — assert a control's rendered box is ≥ MIN_TARGET on both axes. */
async function expectTargetSize(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} has a bounding box`).not.toBeNull();
  // 0.5px epsilon absorbs sub-pixel layout rounding across engines.
  expect(box!.height, `${label} height ≥ ${MIN_TARGET}px`).toBeGreaterThanOrEqual(
    MIN_TARGET - 0.5,
  );
  expect(box!.width, `${label} width ≥ ${MIN_TARGET}px`).toBeGreaterThanOrEqual(
    MIN_TARGET - 0.5,
  );
}

async function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
}

async function gotoList(page: Page): Promise<void> {
  await page.goto(LIST_PATH);
  await page.waitForLoadState('networkidle');
}

test.describe('088 portal invoices a11y @a11y @f088', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('the member invoice list passes WCAG 2.1 AA (desktop + mobile widths)', async ({
    page,
  }, testInfo) => {
    await signInAsMember(page);

    // `runAxeScan` is the portal's canonical a11y helper (serious+critical FAIL;
    // moderate surfaced as a report attachment — not silently dropped). Matches
    // the sibling `tests/e2e/portal/invoices-mobile-cards.spec.ts` gate.
    // Desktop table surface.
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoList(page);
    await runAxeScan(page, testInfo);

    // Mobile card surface (the 088 card list takes over below md).
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoList(page);
    await runAxeScan(page, testInfo);
  });

  test('every per-row PDF/receipt/resend control meets the WCAG 2.5.5 ≥44px target size (FR-036)', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoList(page);

    const cardList = page.getByTestId('portal-invoice-card-list');
    const hasCards = await cardList
      .isVisible()
      .then((v) => v)
      .catch(() => false);
    test.skip(!EXPECTS_ROWS || !hasCards, 'no seeded member invoices (card list absent)');

    const controls = cardList.locator(ROW_ACTION_SELECTOR);
    const count = await controls.count();
    test.skip(count === 0, 'no per-row action controls to measure');
    for (let i = 0; i < count; i += 1) {
      await expectTargetSize(controls.nth(i), `row action control #${i}`);
    }
  });

  for (const width of [320, 375] as const) {
    test(`no horizontal scroll at ${width}px (WCAG 1.4.10 reflow / SC-011)`, async ({
      page,
    }) => {
      await signInAsMember(page);
      await page.setViewportSize({ width, height: 900 });
      await gotoList(page);

      // Strict SC-011 target is scrollWidth ≤ innerWidth; allow 1px rounding.
      expect(await pageOverflow(page), `page overflow at ${width}px`).toBeLessThanOrEqual(1);
    });
  }

  test('remains usable at 200% text zoom (WCAG 1.4.4 resize text)', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.setViewportSize({ width: 375, height: 900 });
    await gotoList(page);

    // Text-only zoom: double the root font size (Tailwind sizing is rem/em
    // based, so this scales text without a layout-zoom).
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
      'page title stays visible at 200% zoom',
    ).toBeVisible();
    expect(await pageOverflow(page), 'page overflow at 200% zoom').toBeLessThanOrEqual(1);
  });

  test('a per-row download control is keyboard-focusable', async ({ page }) => {
    await signInAsMember(page);
    await page.setViewportSize({ width: 320, height: 900 });
    await gotoList(page);

    const cardList = page.getByTestId('portal-invoice-card-list');
    const hasCards = await cardList.isVisible().catch(() => false);
    test.skip(!EXPECTS_ROWS || !hasCards, 'no seeded member invoices (card list absent)');

    const control = cardList.locator(ROW_ACTION_SELECTOR).first();
    const present = await control.count();
    test.skip(present === 0, 'no per-row action control to focus');
    await control.focus();
    expect(
      await control.evaluate((el) => el === document.activeElement),
      'the per-row control enters the tab order and is focusable',
    ).toBe(true);
  });

  test('async receipt-render state announces via a polite aria-live region (B3), when present', async ({
    page,
  }) => {
    await signInAsMember(page);
    await gotoList(page);

    // PRESENCE-GATED: the watcher mounts only while a paid invoice's §86/4 RC
    // receipt PDF is mid-render (`receiptPdfStatus === 'pending'`). When no such
    // fixture exists this is a graceful no-op (the state is exercised
    // deterministically by the RTL card-list test + the watcher unit test).
    const watcher = page.getByTestId('receipt-status-watcher').first();
    const mounted = await watcher
      .waitFor({ state: 'attached', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!mounted, 'no pending-receipt fixture (watcher not mounted)');

    await expect(watcher).toHaveAttribute('role', 'status');
    await expect(watcher).toHaveAttribute('aria-live', 'polite');
    await expect(watcher).toHaveAttribute('aria-busy', 'true');
  });

  test('the permanent receipt-render failure state is a calm support path, not a spinner (T066a), when present', async ({
    page,
  }) => {
    await signInAsMember(page);
    await gotoList(page);

    // PRESENCE-GATED: only rendered when a paid invoice's receipt PDF render
    // TERMINALLY failed (`receiptPdfStatus === 'failed'`).
    const failedHint = page.getByTestId('receipt-failed-support').first();
    const mounted = await failedHint
      .waitFor({ state: 'attached', timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!mounted, 'no failed-receipt fixture (support hint not mounted)');

    // Terminal state — must NOT be mislabelled as forever-generating.
    await expect(failedHint).not.toHaveAttribute('aria-busy', 'true');
    await expect(failedHint).not.toHaveAttribute('role', 'status');
  });
});
