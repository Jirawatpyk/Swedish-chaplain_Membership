/**
 * T043 (rewritten for F5) — E2E: portal pages use content-type-based containers.
 *
 *   /portal, /portal/profile, /portal/account, /portal/contacts/invite
 *                     → DetailContainer: AURA's default Container, 1280px at 1440
 *   /portal/edit      → FormContainer, widened to the boards' 880px column
 */
import { expect, test } from './fixtures';
import { signInViaForm, waitForLayoutContainer } from './helpers/layout';

// Profile, edit and the invite page are not on the lapsed allowlist
// (lib/lapsed-portal-scope) and the F8 renewals seed terminates the default
// persona in global setup, so this walk signs in as the good-standing one.
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;

type Variant = 'detail' | 'form';

const PAGES: Array<{ path: string; variant: Variant }> = [
  { path: '/portal', variant: 'detail' },
  { path: '/portal/profile', variant: 'detail' },
  // 058 consolidated the account hub onto DetailContainer; the invite page
  // reads as a detail page too. Only the propose-changes form is a form.
  { path: '/portal/account', variant: 'detail' },
  { path: '/portal/edit', variant: 'form' },
  { path: '/portal/contacts/invite', variant: 'detail' },
];

test.describe('F5 portal layout @layout', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_EMAIL_EMPTY / _PASSWORD_EMPTY not set');

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
        // AURA's default Container, as on the admin detail pages (spec 122,
        // 2 Oct 2026; the portal had its own 1200px content column before).
        expect(boxWidth).toBeGreaterThanOrEqual(1279);
        expect(boxWidth).toBeLessThanOrEqual(1281);
      } else {
        // `/portal/edit` widens its FormContainer to the boards' 880px
        // column (`55rem + 2 * --page-padding-x`), so 944px at 1440.
        expect(boxWidth).toBeGreaterThanOrEqual(936);
        expect(boxWidth).toBeLessThanOrEqual(952);
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
