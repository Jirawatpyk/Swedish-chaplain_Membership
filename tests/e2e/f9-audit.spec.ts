/**
 * T041 (F9 US2) — `@f9` audit-log viewer E2E.
 *
 * Runs against the deployed `swecham` tenant (real seeded audit_log). Asserts
 * STRUCTURE + role projection rather than exact rows (audit data drifts).
 *
 * ── 016 RBAC v2 D4 NARROWING (cutover 2026-08-11) ────────────────────────────
 * `audit.read` is now a `superAdminOnly` permission. Two of the three cells this
 * suite pinned therefore changed, and this is the DESIGNED outcome, not a
 * regression (design § 10 "D4 — permanent capability narrowings"):
 *
 *   - super_admin → the full viewer (this is who the old "admin" case became;
 *                   post-Migration-C every human admin IS a super_admin)
 *   - manager     → **DENIED**. The old title cited FR-011 "role allowed"; D4
 *                   supersedes it — the read-only-on-finance role no longer
 *                   reaches the audit log at all. The denial is `notFound()`,
 *                   so the page CONTENT is absent rather than redirected.
 *   - member      → denied, unchanged (bounced off /admin/* by the layout guard
 *                   before the permission gate even runs)
 *
 * A PLAIN admin is also denied now; that cell is covered by
 * `rbac-admin-persona.spec.ts` rather than duplicated here.
 *
 * Requires `FEATURE_F9_DASHBOARD=true` + E2E_{SUPER_ADMIN,MANAGER,MEMBER}_* in
 * `.env.local`. Run with `pnpm test:e2e --grep "@f9" --workers=1`.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsSuperAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import { signInAsMember } from './helpers/member-session';

const SUPER_ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const F9_ENABLED = process.env.FEATURE_F9_DASHBOARD === 'true';

/** The viewer's own content must be absent — never assert on <title>, which
 *  `generateMetadata` still resolves on a not-found render. */
async function expectAuditViewerAbsent(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /export csv/i })).toHaveCount(0);
}

test.describe('F9 — audit-log viewer (US2) @f9', () => {
  test.beforeAll(() => {
    if (!SUPER_ADMIN_EMAIL || !MANAGER_EMAIL || !MEMBER_EMAIL) {
      throw new Error(
        'E2E_SUPER_ADMIN_EMAIL / E2E_MANAGER_EMAIL / E2E_MEMBER_EMAIL missing — set them in .env.local before running this suite (scripts/seed-e2e-user.ts mints them).',
      );
    }
    if (!F9_ENABLED) {
      throw new Error(
        'FEATURE_F9_DASHBOARD=false — set FEATURE_F9_DASHBOARD=true in .env.local before running this suite.',
      );
    }
  });

  test('super_admin sees the audit table, filters + export, and the event-type filter round-trips', async ({
    page,
  }) => {
    await signInAsSuperAdmin(page);
    await page.goto('/admin/audit');

    await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
    // Read-only table present (FR-008/010) + export affordance (FR-012).
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('link', { name: /export csv/i })).toBeVisible();

    // Event-type filter (FR-009): pick the first real type (options show the
    // LOCALISED label, not the raw code), expect it to commit to the URL.
    const eventFilter = page.getByRole('combobox', { name: /event type/i });
    await expect(eventFilter).toBeVisible();
    await eventFilter.click();
    // nth(0) is "All event types"; nth(1) is the first concrete event type.
    await page.getByRole('option').nth(1).click();
    await page.waitForURL(/eventType=/, { timeout: 15_000 });
    // The filtered view re-renders without crashing — either a results table or
    // the empty-state copy (the chosen type may have no rows in this tenant).
    await expect(
      page.getByRole('table').or(page.getByText(/no audit events match/i)),
    ).toBeVisible();
  });

  test('manager is DENIED the audit viewer (016 D4 supersedes FR-011)', async ({ page }) => {
    // Inverted at the RBAC v2 cutover. Pre-016 the manager held the read-only
    // viewer under FR-011; `audit.read` is now superAdminOnly, so the page gate
    // answers notFound(). Manager stays ON /admin/audit (the (staff) layout
    // admits it — manager is still staff) and simply gets the not-found UI, so
    // there is no redirect to wait for: assert the CONTENT is gone.
    await signInAsManager(page);
    await page.goto('/admin/audit', { waitUntil: 'domcontentloaded' });
    await expectAuditViewerAbsent(page);
  });

  test('member is denied the audit viewer (redirected off /admin/audit)', async ({
    page,
  }) => {
    // A member is bounced EARLIER than a manager: the (staff)/admin layout
    // redirects role=member to /portal before the page's permission gate runs.
    await signInAsMember(page);
    await page.goto('/admin/audit');
    await page.waitForURL((url) => !url.pathname.includes('/admin/audit'), {
      timeout: 15_000,
    });
    await expectAuditViewerAbsent(page);
  });
});
