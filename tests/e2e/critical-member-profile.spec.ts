/**
 * @critical slim path: a member reads their own profile on the seeded
 * `swecham` tenant (spec 123 slice 2, DW-7; PR #586 review H4). Read only.
 *
 * The good-standing persona (`E2E_MEMBER_EMAIL_EMPTY`), not the default one:
 * global setup lapses the default member (renewals seed), and a lapsed scope
 * is refused before the page renders. seed-e2e-portal-invoices links that
 * persona to "E2E Echo Co" with the primary contact "E2E Echo".
 */
import { expect } from './fixtures';
import { goodStandingMemberCredentials, goodStandingMemberTest as test } from './helpers/member-session';

const COMPANY = 'E2E Echo Co';
const CONTACT = 'E2E Echo';

test.describe('member reads their own profile @critical', () => {
  test.skip(!goodStandingMemberCredentials(), 'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY');

  test('the portal profile shows the member’s own company and name', async ({ page }) => {
    await page.goto('/portal/profile');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
    const main = page.getByRole('main');
    await expect(main.getByText(COMPANY, { exact: true }).first()).toBeVisible({ timeout: 15_000 });
    await expect(main.getByText(CONTACT, { exact: true }).first()).toBeVisible();
  });
});
