/**
 * T023 (F9 US1) — `@f9` admin operations dashboard E2E.
 *
 * Runs against the deployed `swecham` tenant (real seeded data). Asserts
 * STRUCTURE + role projection rather than exact counts (counts drift):
 *   - admin → KPIs (incl. a THB revenue value), needs-attention links,
 *     smart insights, live activity feed, "as of" freshness
 *   - manager → finance-redacted (no THB revenue in the KPI region)
 *   - member → denied (redirected off /admin)
 *
 * Requires `FEATURE_F9_DASHBOARD=true` + E2E_{ADMIN,MANAGER,MEMBER}_* in
 * `.env.local`. Run with `pnpm test:e2e --grep "@f9" --workers=1`.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import { signInAsMember } from './helpers/member-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const F9_ENABLED = process.env.FEATURE_F9_DASHBOARD === 'true';

test.describe('F9 — admin operations dashboard (US1) @f9', () => {
  test.beforeAll(() => {
    if (!ADMIN_EMAIL || !MANAGER_EMAIL || !MEMBER_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL / E2E_MANAGER_EMAIL / E2E_MEMBER_EMAIL missing — set them in .env.local before running this suite.',
      );
    }
    if (!F9_ENABLED) {
      throw new Error(
        'FEATURE_F9_DASHBOARD=false — set FEATURE_F9_DASHBOARD=true in .env.local before running this suite.',
      );
    }
  });

  test('admin sees KPIs, needs-attention links, insights, activity feed + revenue', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin');

    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    // "As of {time}" freshness (FR-005).
    await expect(page.getByText(/As of /i)).toBeVisible();

    const metrics = page.getByRole('region', { name: /key metrics/i });
    await expect(metrics).toBeVisible();
    await expect(metrics.getByText('Total members')).toBeVisible();
    await expect(metrics.getByText('Active members')).toBeVisible();
    await expect(metrics.getByText('At-risk members')).toBeVisible();
    await expect(metrics.getByText('Paid revenue (YTD)')).toBeVisible();
    // Admin sees the real THB revenue figure (not redacted).
    await expect(metrics.getByText(/THB|฿/)).toBeVisible();

    // Needs-attention section (FR-002). Items with a zero count are filtered
    // out (D5) — when the tenant has none, an "all clear" state shows instead.
    // So assert the section heading always renders, and verify each item's href
    // only when that item is present (count > 0).
    await expect(page.getByText('Needs attention')).toBeVisible();
    const overdueLink = page.getByRole('link', { name: /overdue invoices/i });
    if ((await overdueLink.count()) > 0) {
      await expect(overdueLink).toHaveAttribute('href', '/admin/invoices?status=issued');
    }
    const atRiskLink = page.getByRole('link', { name: /at-risk members/i });
    if ((await atRiskLink.count()) > 0) {
      await expect(atRiskLink).toHaveAttribute('href', '/admin/members?risk_band=at-risk');
    }

    // Smart insights + live activity feed sections.
    await expect(page.getByText('Smart insights')).toBeVisible();
    await expect(page.getByText('Recent activity')).toBeVisible();
  });

  test('manager sees a finance-redacted dashboard (no revenue figure)', async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto('/admin');

    const metrics = page.getByRole('region', { name: /key metrics/i });
    await expect(metrics).toBeVisible();
    // The revenue label is still shown...
    await expect(metrics.getByText('Paid revenue (YTD)')).toBeVisible();
    // ...but the value is redacted — no THB currency figure in the KPI region.
    await expect(metrics.getByText(/THB|฿/)).toHaveCount(0);
    // Non-finance counts remain visible.
    await expect(metrics.getByText('Active members')).toBeVisible();
  });

  test('member is denied the staff dashboard (redirected off /admin)', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/admin');
    // requireSession('staff') redirects a member away from the dashboard.
    await page.waitForURL((url) => !url.pathname.endsWith('/admin'), {
      timeout: 15_000,
    });
    await expect(
      page.getByRole('heading', { name: 'Dashboard', level: 1 }),
    ).toHaveCount(0);
  });
});
