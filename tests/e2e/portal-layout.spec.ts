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

      // h1 is only present when the member account is linked to a
      // Member entity. The unlinked early-return path renders an
      // explanatory <p> inside the container instead — still valid F5
      // behaviour (container present + correct width). Skip the h1
      // assertion in that state so unseeded e2e environments don't
      // false-fail.
      const notLinked = await page
        .getByText(/not linked|please contact your administrator/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (!notLinked) {
        const h1 = page.getByRole('heading', { level: 1 });
        await expect(h1).toBeVisible();
      }
    }
  });
});
