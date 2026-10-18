/**
 * @critical slim path: a member reads their own profile on the seeded
 * `swecham` tenant (spec 123 slice 2, DW-7; PR #586 review H4). Read only.
 *
 * The good-standing persona (`E2E_MEMBER_EMAIL_EMPTY`), not the default one:
 * global setup lapses the default member (renewals seed), and a lapsed scope
 * is refused before the page renders. seed-e2e-portal-invoices links that
 * persona to "E2E Echo Co" with the primary contact "E2E Echo", listed as
 * "E2E Echo (you)".
 */
import { expect } from './fixtures';
import { goodStandingMemberCredentials, goodStandingMemberTest as test } from './helpers/member-session';

const COMPANY = 'E2E Echo Co';
// The contacts card marks the signed-in member's own row "(you)" (run 39108085903).
const OWN_CONTACT = 'E2E Echo (you)';

test.describe('member reads their own profile @critical', () => {
  test.skip(!goodStandingMemberCredentials(), 'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY');

  test('the portal profile shows the member’s own company and name', async ({ page }) => {
    await page.goto('/portal/profile');
    // Visible-only and strict, no `.first()`: the company is the page's h1, and
    // the member's own contact row is the one marked "(you)".
    await expect(page.getByRole('heading', { level: 1, name: COMPANY }).filter({ visible: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByRole('main').getByText(OWN_CONTACT, { exact: true }).filter({ visible: true })).toBeVisible();
  });
});
