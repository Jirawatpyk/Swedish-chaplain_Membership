/**
 * T061 — E2E: F4 US4/SC-009 top bars. Spec 122 US1 moved both to the AURA
 * boards, which size them differently on purpose: the staff bar is AppShell's
 * 56px; the portal header is 72px from 1024px and 64px below (portal `Main` /
 * `Home-mobile`). Both keep a stable height, so neither shifts the page.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsMember } from './helpers/member-sign-in';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe('F4 SC-009 — top bar consistency @layout', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD || !MEMBER_EMAIL || !MEMBER_PASSWORD,
    'E2E_ADMIN_* and E2E_MEMBER_* not set',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('the staff bar is 56px and the portal header 72 / 64px, as on the boards', async ({ browser }) => {
    // Two full sign-ins (staff + member) in one test, each allowed 60 s for a
    // cold-compiled landing route by the shared helpers.
    test.setTimeout(150_000);
    const adminCtx = await browser.newContext();
    const memberCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const memberPage = await memberCtx.newPage();

    // The shared helpers, not an inline `.fill()`: on WebKit a plain fill
    // left the email empty while the password filled (R6), so the form never
    // submitted. They also wait for the landing fetches (sign-in-landing.ts).
    await signInAsAdmin(adminPage);
    await signInAsMember(memberPage);

    const adminHeader = await adminPage.locator('header').first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        paddingInlineStart: cs.paddingInlineStart,
        paddingInlineEnd: cs.paddingInlineEnd,
        gap: cs.gap,
      };
    });
    const portalHeader = await memberPage.locator('header').first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        height: el.getBoundingClientRect().height,
        paddingInlineStart: cs.paddingInlineStart,
        paddingInlineEnd: cs.paddingInlineEnd,
        gap: cs.gap,
      };
    });

    const wide = (memberPage.viewportSize()?.width ?? 1280) >= 1024;
    expect(adminHeader.height).toBe(56);
    // +1px: the portal header's bottom hairline sits outside its content row.
    expect(portalHeader.height).toBe(wide ? 73 : 65);

    await adminCtx.close();
    await memberCtx.close();
  });
});
