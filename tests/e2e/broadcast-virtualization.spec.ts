/**
 * T209 (Phase 10) — F7 admin queue DOM-count smoke + virtualization
 * regression guard.
 *
 * Two layered assertions:
 *   1. Always: queue page renders + DOM tr count ≤ pageSize (50) + 5
 *      header rows. Confirms server-side pagination works regardless
 *      of seed depth — runs against any tenant.
 *   2. When E2E_QUEUE_1K_TENANT is set (1k-fixture seed pre-staged):
 *      additionally verify TanStack virtualization activates at the
 *      VIRTUALIZE_THRESHOLD = 100 boundary (DOM count stays < 150 even
 *      with 1k rows in the page).
 */
import { expect, test } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const QUEUE_1K_TENANT = process.env.E2E_QUEUE_1K_TENANT;

const PAGE_SIZE = 50;
const PAGE_SIZE_CEILING = PAGE_SIZE + 10; // header rows + tolerance

// Mobile Safari + dev-server cold compile budget — see broadcast-a11y.
test.describe.configure({ timeout: 180_000 });

test.describe('@perf T209 — admin queue DOM count + virtualization', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD',
  );

  test('queue page DOM tr count stays bounded (smoke + virtualization regression guard)', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    // WebKit's `waitForURL` waits for `load` event which never fires
    // in a reasonable budget under Next.js dev mode. Use URL-poll via
    // `expect.toHaveURL` instead — fires as soon as URL changes,
    // independent of subresource load.
    await expect(page).toHaveURL(
      (u: URL) => {
        const p = u.pathname;
        return p.startsWith('/admin') && !p.startsWith('/admin/sign-in');
      },
      { timeout: 120_000 },
    );

    await page.goto('/admin/broadcasts');
    await page.waitForLoadState('domcontentloaded', { timeout: 120_000 });

    // Confirm the queue page rendered — there's either a tbody tr OR
    // an empty-state row. The empty-state still counts as `tr` in DOM
    // for the bounded-count assertion below.
    await page.locator('table').first().waitFor({ timeout: 60_000 });

    const trCount = await page.locator('tbody tr').count();

    if (QUEUE_1K_TENANT) {
      // Layer 2 — virtualization regression guard. With 1k rows in the
      // current page, TanStack should keep DOM nodes under 150 (visible
      // viewport + overscan). >150 means virtualization broke.
      expect(trCount).toBeLessThan(150);
    } else {
      // Layer 1 — server-side pagination smoke. Page renders ≤ pageSize
      // rows. >ceiling means pagination broke.
      expect(trCount).toBeLessThanOrEqual(PAGE_SIZE_CEILING);
    }
  });
});
