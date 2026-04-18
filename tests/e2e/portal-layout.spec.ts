/**
 * T043 (rewritten for F5) — E2E: portal pages use content-type-based containers.
 *
 *   /portal           → DetailContainer (72rem = 1152px at 1440px viewport)
 *   /portal/profile   → DetailContainer (same)
 *   /portal/account   → FormContainer  (42rem ≈ 672±8px)
 *   /portal/edit      → FormContainer
 *   /portal/contacts/invite → FormContainer
 */
import { expect, test } from './fixtures';
import { signInViaForm, waitForLayoutContainer } from './helpers/layout';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

type Variant = 'detail' | 'form';

const PAGES: Array<{ path: string; variant: Variant }> = [
  { path: '/portal', variant: 'detail' },
  { path: '/portal/profile', variant: 'detail' },
  { path: '/portal/account', variant: 'form' },
  { path: '/portal/edit', variant: 'form' },
  { path: '/portal/contacts/invite', variant: 'form' },
];

test.describe('F5 portal layout @layout', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');

  test('portal pages use the correct content-type container at 1440px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );

    for (const { path, variant } of PAGES) {
      await page.goto(path);
      await waitForLayoutContainer(page);
      const container = page
        .locator(`[data-slot="layout-container"][data-variant="${variant}"]`)
        .first();
      await expect(container, `${path} has ${variant} container`).toBeVisible();

      const boxWidth = await container.evaluate(
        (el) => (el as HTMLElement).getBoundingClientRect().width,
      );
      if (variant === 'detail') {
        expect(boxWidth).toBeGreaterThanOrEqual(1148);
        expect(boxWidth).toBeLessThanOrEqual(1156);
      } else {
        expect(boxWidth).toBeGreaterThanOrEqual(664);
        expect(boxWidth).toBeLessThanOrEqual(680);
      }

      // The page MUST render either an h1 (linked-member happy path)
      // or the explanatory "not linked" message (unseeded e2e
      // environment). A page that renders the container but neither
      // is a real regression — fail loudly. Tightens the prior
      // resilience guard which silently no-op'd on unseeded envs.
      const h1Visible = await page
        .getByRole('heading', { level: 1 })
        .first()
        .isVisible()
        .catch(() => false);
      const notLinkedVisible = await page
        .getByText(/not linked|please contact your administrator/i)
        .first()
        .isVisible()
        .catch(() => false);
      expect(
        h1Visible || notLinkedVisible,
        `${path} must render either an <h1> or the "not linked" message`,
      ).toBe(true);
    }
  });
});
