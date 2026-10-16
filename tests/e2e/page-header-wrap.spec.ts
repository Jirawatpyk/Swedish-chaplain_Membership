/**
 * T031 — E2E: F4 US2 PageHeader action wrap below 640px.
 *
 * Spec 122 (#151): the header is AURA's PageHeader with
 * `actionsFullWidthBelow="sm"`. Below 640px the actions take the whole row
 * under the text; once the row fits they sit at the end of the header's row.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('F4 US2 — page header action wrap @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('actions take their own row at 639px, stay contained at 641px, sit at the end of the row at 700px', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    await page.goto('/admin/plans');

    const header = page.locator('[data-slot="page-header"]').first();
    const actions = header.locator('.aura-page-header__actions');
    // Actions may be rendered as <a> (Link asChild) or <button>.
    await expect(actions.locator(':is(a, button)').first(), 'header must render at least one action').toBeVisible();

    const boxes = async () => {
      const h = await header.boundingBox();
      const a = await actions.boundingBox();
      const t = await header.locator('.aura-page-header__text').boundingBox();
      if (!h || !a || !t) throw new Error('header, text or actions has no box');
      return { h, a, t };
    };

    await page.setViewportSize({ width: 639, height: 900 });
    let { h, a, t } = await boxes();
    expect(a.y, 'at 639px the actions sit under the text').toBeGreaterThanOrEqual(t.y + t.height - 1);
    expect(a.width, 'at 639px the actions span the header').toBeGreaterThan(h.width - 2);

    // From 640px to about 654px AURA's 320px text basis plus the gap and
    // the two actions overflow the header, so the actions wrap under the
    // text at their natural width (AURA's default; spec 122 parity rule).
    // There only containment must hold.
    await page.setViewportSize({ width: 641, height: 900 });
    ({ h, a, t } = await boxes());
    expect(a.x, 'at 641px the actions stay inside the header').toBeGreaterThanOrEqual(h.x - 1);
    expect(a.x + a.width, 'at 641px the actions stay inside the header').toBeLessThanOrEqual(h.x + h.width + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      'at 641px the page does not scroll sideways',
    ).toBeLessThanOrEqual(0);

    await page.setViewportSize({ width: 700, height: 900 });
    ({ h, a, t } = await boxes());
    expect(a.x, 'at 700px the actions sit beside the text').toBeGreaterThan(t.x + 1);
    expect(a.x + a.width, 'the actions end at the header’s end').toBeCloseTo(h.x + h.width, 0);
  });
});
