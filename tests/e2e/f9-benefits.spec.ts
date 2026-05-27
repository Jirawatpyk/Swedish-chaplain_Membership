/**
 * T062 (F9 US4) — `@f9` member benefit-usage dashboard E2E.
 *
 * Runs against the deployed `swecham` tenant (real seeded data). Asserts
 * STRUCTURE + behaviour, not exact figures (consumption drifts):
 *   - admin  → opens a member's /admin/members/[id]/benefits, sees the benefit
 *              card (or the no-quantifiable-benefits empty state) + back link
 *   - member → opens their OWN /portal/benefits and sees the page heading +
 *              the benefit card (own benefits only; the figures + redaction are
 *              asserted at the use-case/integration layer)
 *
 * US4 adds member + staff read-only pages that enrich shipped F2/F6/F7 data, so
 * — like the US3 timeline — they are NOT behind FEATURE_F9_DASHBOARD. Requires
 * E2E_{ADMIN,MEMBER}_* in `.env.local`. Run with
 * `pnpm test:e2e --grep "@f9" --workers=1`.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsMember } from './helpers/member-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;

async function firstMemberId(page: Page): Promise<string> {
  await page.goto('/admin/members');
  const firstRow = page.locator('table tbody tr').first();
  await firstRow.waitFor({ timeout: 15_000 });
  const href = await firstRow.locator('a').first().getAttribute('href');
  if (!href) throw new Error('No member rows — seed required');
  const match = href.match(/\/admin\/members\/([0-9a-f-]+)/);
  if (!match) throw new Error(`Could not parse memberId from ${href}`);
  return match[1]!;
}

test.describe('F9 — member benefit usage dashboard (US4) @f9', () => {
  test.beforeAll(() => {
    if (!ADMIN_EMAIL || !MEMBER_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL / E2E_MEMBER_EMAIL missing — set them in .env.local before running this suite.',
      );
    }
  });

  test('admin sees a member benefit view (card or empty state) + back link', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const memberId = await firstMemberId(page);
    await page.goto(`/admin/members/${memberId}/benefits`);

    await expect(
      page.getByRole('heading', { name: 'Member benefits', level: 1 }),
    ).toBeVisible();

    // Either the benefit card (title "Benefit usage · YYYY") or the
    // no-quantifiable-benefits empty state — both are valid, no crash.
    await expect(
      page
        .getByText(/benefit usage/i)
        .or(page.getByText(/no quantifiable benefits/i)),
    ).toBeVisible();

    await expect(page.getByRole('link', { name: /back to member/i })).toBeVisible();
  });

  test('member sees their OWN benefits at /portal/benefits', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/benefits');

    await expect(
      page.getByRole('heading', { name: 'Benefits', level: 1 }),
    ).toBeVisible();

    // The benefit card, the no-quantifiable empty state, or (unlinked account)
    // the missing-profile message — all are valid renders, none crash.
    await expect(
      page
        .getByText(/benefit usage/i)
        .or(page.getByText(/no quantifiable benefits/i))
        .or(page.getByText(/membership profile/i)),
    ).toBeVisible();
  });
});
