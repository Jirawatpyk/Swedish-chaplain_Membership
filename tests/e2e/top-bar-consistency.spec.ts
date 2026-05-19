/**
 * T061 — E2E: F4 US4/SC-009 admin + portal top bar identical 56px.
 */
import { expect, test } from './fixtures';
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

  test('admin and portal headers compute identical 56px height + padding', async ({ browser }) => {
    const adminCtx = await browser.newContext();
    const memberCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    const memberPage = await memberCtx.newPage();

    await adminPage.goto('/admin/sign-in');
    await adminPage.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await adminPage.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await adminPage.getByRole('button', { name: /sign in/i }).click();
    await adminPage.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    await memberPage.goto('/portal/sign-in');
    await memberPage.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await memberPage.getByRole('textbox', { name: /^password$/i }).fill(MEMBER_PASSWORD!);
    await memberPage.getByRole('button', { name: /sign in/i }).click();
    await memberPage.waitForURL((u) => { const p = new URL(u).pathname; return /^\/portal(\/|$)/.test(p) && !p.startsWith("/portal/sign-in"); });

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

    expect(adminHeader.height).toBe(56);
    expect(portalHeader.height).toBe(56);
    expect(adminHeader.paddingInlineStart).toBe(portalHeader.paddingInlineStart);
    expect(adminHeader.paddingInlineEnd).toBe(portalHeader.paddingInlineEnd);

    await adminCtx.close();
    await memberCtx.close();
  });
});
