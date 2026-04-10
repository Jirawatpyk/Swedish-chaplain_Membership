/**
 * T166 — Idle-warning dialog E2E (spec FR-022, SC-013).
 *
 * Validates the idle-warning UX:
 *   1. Sign in as admin.
 *   2. Stub the client-side idle timer so the modal appears immediately
 *      (we can't wait 29 real minutes in CI).
 *   3. Assert the modal is visible with the correct title / description.
 *   4. Click "Stay signed in" and assert the modal closes.
 *   5. Assert POST /api/auth/heartbeat was called.
 *
 * The idle timer logic lives in src/components/auth/idle-warning-dialog.tsx
 * and uses `setInterval(5_000)` to poll `lastActivityRef.current`. In
 * this test we inject a hook that sets `lastActivityRef` to a time
 * well in the past, then wait for the polling interval to notice.
 *
 * Skips without admin credentials.
 */
import { expect, test } from '@playwright/test';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('idle-warning dialog (T166, SC-013)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD to run',
  );

  test('modal appears when idle, Stay signed in calls heartbeat + closes', async ({
    page,
  }) => {
    // Install a Date.now() offset BEFORE any page script runs so the
    // idle-warning effect reads a fake clock.
    await page.addInitScript(() => {
      // @ts-expect-error — test-only global
      window.__clockOffset = 0;
      const realNow = Date.now.bind(Date);
      (Date as unknown as { now: () => number }).now = () => {
        // @ts-expect-error — test-only global
        return realNow() + (window.__clockOffset ?? 0);
      };
    });

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    // Fast-forward the client clock by 29 minutes + 1 s so the next
    // idle-poll tick fires the warning.
    await page.evaluate(() => {
      // @ts-expect-error — test-only global
      window.__clockOffset = 29 * 60 * 1000 + 1000;
    });

    // The idle poll runs every 5 s (see idle-warning-dialog.tsx). Wait
    // up to 12 s for the modal to appear.
    const modal = page.getByRole('alertdialog');
    await expect(modal).toBeVisible({ timeout: 12_000 });
    // Use .first() because the title heading AND the aria-live
    // description both contain "seconds" in English — strict mode
    // otherwise rejects the ambiguous match.
    await expect(modal.getByRole('heading', { name: /still there/i })).toBeVisible();

    // Click "Stay signed in" and watch for the heartbeat POST.
    const stayBtn = modal.getByRole('button', { name: /stay/i });
    const [heartbeatResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/heartbeat') && r.request().method() === 'POST',
        { timeout: 5_000 },
      ),
      stayBtn.click(),
    ]);
    expect(heartbeatResponse.status()).toBe(200);

    // Modal should close
    await expect(modal).not.toBeVisible();
  });
});
