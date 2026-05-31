/**
 * T041 (F9 US2) — `@f9` audit-log viewer E2E.
 *
 * Runs against the deployed `swecham` tenant (real seeded audit_log). Asserts
 * STRUCTURE + role projection rather than exact rows (audit data drifts):
 *   - admin   → heading, filter bar, the audit table, an export link, and a
 *               working event-type filter that round-trips through the URL
 *   - manager → same read-only viewer + export (the "read-only on finance" role
 *               may view the audit log; payload redaction is asserted at the
 *               use-case/integration layer, not here)
 *   - member  → denied (redirected off /admin/audit)
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

test.describe('F9 — audit-log viewer (US2) @f9', () => {
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

  test('admin sees the audit table, filters + export, and the event-type filter round-trips', async ({
    page,
  }) => {
    await signInAsAdmin(page);
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

  test('manager sees the read-only audit viewer + export (FR-011 role allowed)', async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto('/admin/audit');

    await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await expect(page.getByRole('link', { name: /export csv/i })).toBeVisible();
  });

  test('member is denied the audit viewer (redirected off /admin/audit)', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/admin/audit');
    await page.waitForURL((url) => !url.pathname.includes('/admin/audit'), {
      timeout: 15_000,
    });
    await expect(
      page.getByRole('heading', { name: 'Audit log', level: 1 }),
    ).toHaveCount(0);
  });
});
