/**
 * T053 (F9 US3) — `@f9` unified multi-source timeline E2E.
 *
 * Runs against the deployed `swecham` tenant (real seeded data). Asserts
 * STRUCTURE + behaviour rather than exact rows (timeline data drifts):
 *   - admin   → opens a member timeline, sees the filter bar (source + actor)
 *               and the entry stream; the source filter round-trips via the URL
 *   - member  → opens their OWN /portal/timeline and sees the page + filter bar
 *               (own-history-only; payload redaction is asserted at the
 *               use-case/integration layer, not here)
 *
 * The timeline is an in-place enrichment of the shipped F3 route, so it is NOT
 * behind FEATURE_F9_DASHBOARD. Requires E2E_{ADMIN,MEMBER}_* in `.env.local`.
 * Run with `pnpm test:e2e --grep "@f9" --workers=1`.
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

test.describe('F9 — unified multi-source timeline (US3) @f9', () => {
  test.beforeAll(() => {
    if (!ADMIN_EMAIL || !MEMBER_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL / E2E_MEMBER_EMAIL missing — set them in .env.local before running this suite.',
      );
    }
  });

  test('admin sees the timeline filter bar + stream, and the source filter round-trips', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const memberId = await firstMemberId(page);
    await page.goto(`/admin/members/${memberId}/timeline`);

    await expect(
      page.getByRole('heading', { name: 'Timeline', level: 1 }),
    ).toBeVisible();

    // Filter bar (FR-015): source + actor comboboxes present.
    const sourceFilter = page.getByRole('combobox', { name: /source/i });
    const actorFilter = page.getByRole('combobox', { name: /actor/i });
    await expect(sourceFilter).toBeVisible();
    await expect(actorFilter).toBeVisible();

    // The source filter commits to the URL and the view re-renders (a stream
    // of entries OR the filtered empty-state — no crash).
    await sourceFilter.click();
    // nth(0) = "All"; nth(1) = the first concrete source.
    await page.getByRole('option').nth(1).click();
    await page.waitForURL(/source=/, { timeout: 15_000 });
    // Scope to the timeline list by its accessible name ("Timeline") — a bare
    // getByRole('list') also matches the breadcrumb <ol> (strict-mode clash).
    await expect(
      page
        .getByRole('list', { name: 'Timeline' })
        .or(page.getByText(/no activity matches the current filters/i))
        .or(page.getByText(/no activity recorded yet/i)),
    ).toBeVisible();
  });

  test('member sees their OWN timeline at /portal/timeline', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/timeline');

    await expect(
      page.getByRole('heading', { name: 'Activity timeline', level: 1 }),
    ).toBeVisible();
    // Filter bar present; the member can only ever see their own history.
    await expect(page.getByRole('combobox', { name: /source/i })).toBeVisible();
    // Either an entry stream or a friendly empty state — both are valid.
    await expect(
      page
        .getByRole('list')
        .or(page.getByText(/no activity recorded yet/i))
        .or(page.getByText(/no activity matches/i)),
    ).toBeVisible();
  });
});
