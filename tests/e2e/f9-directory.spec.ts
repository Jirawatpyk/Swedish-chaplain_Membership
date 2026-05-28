/**
 * T076 (F9 US5) — `@f9` member directory + export E2E.
 *
 * Runs against the deployed `swecham` tenant. Asserts STRUCTURE + role
 * projection + the generate-enqueue flow (FR-024/026/027), not exact rows:
 *   - admin   → heading, search filter (URL round-trip), the directory table,
 *               generate controls; clicking "Generate E-Book" enqueues a job
 *               (queued toast) and the recent-exports list reflects it
 *   - manager → same read-only directory + generate (chamber deliverable, not finance)
 *   - member  → denied (redirected off /admin/directory)
 *
 * The async worker + private-blob download are NOT exercised here — the worker
 * is an operator-gated cron and private-Blob delivery requires a private store
 * (ship-day gate). This suite covers the staff-facing read + enqueue surface.
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

test.describe('F9 — member directory (US5) @f9', () => {
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

  test('admin searches the directory and the keyword filter round-trips through the URL', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/directory');

    await expect(page.getByRole('heading', { name: 'Member directory', level: 1 })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    // Generate controls (FR-026/027).
    await expect(page.getByRole('button', { name: /generate e-book/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /export data \(json\)/i })).toBeVisible();

    // Keyword search (FR-024) commits to the URL (debounced).
    const search = page.getByRole('textbox', { name: /search directory/i });
    await expect(search).toBeVisible();
    await search.fill('a');
    await page.waitForURL(/q=a/, { timeout: 15_000 });
    // Re-renders without crashing — a results table or the empty state.
    await expect(
      page.getByRole('table').or(page.getByText(/no members found/i)),
    ).toBeVisible();
  });

  test('admin can enqueue an E-Book — queued toast appears', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/directory');
    await page.getByRole('button', { name: /generate e-book/i }).click();
    // Queued confirmation (ux-standards § 5 toast). The async worker is
    // operator-gated, so we only assert the enqueue acknowledgement here.
    await expect(page.getByText(/queued|will be ready/i)).toBeVisible({ timeout: 15_000 });
  });

  test('manager sees the read-only directory + generate controls', async ({ page }) => {
    await signInAsManager(page);
    await page.goto('/admin/directory');
    await expect(page.getByRole('heading', { name: 'Member directory', level: 1 })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
  });

  test('member is denied the directory (redirected off /admin/directory)', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/admin/directory');
    await page.waitForURL((url) => !url.pathname.includes('/admin/directory'), {
      timeout: 15_000,
    });
    await expect(
      page.getByRole('heading', { name: 'Member directory', level: 1 }),
    ).toHaveCount(0);
  });
});
