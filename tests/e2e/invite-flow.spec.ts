/**
 * T119 — Invitation flow E2E (spec SC-008, US4 AS1).
 *
 * Measures the admin-side wall-clock duration for sending an
 * invitation through the `InviteUserDialog` on `/admin/users`.
 * Spec SC-008 budget is 300 seconds for the full human-in-the-loop
 * flow (admin clicks → invitee clicks email → sets password → lands
 * home); the automated portion here covers JUST the admin side and
 * should complete in well under 10 seconds.
 *
 * Steps:
 *   1. Sign in as admin.
 *   2. Navigate to /admin/users.
 *   3. Click the "Invite user" button → dialog opens.
 *   4. Fill email + role in the dialog.
 *   5. Click "Send invitation" → wait for `/api/auth/invite` 201.
 *   6. Assert success toast, dialog closes.
 *   7. Assert wall-clock elapsed < 300 s (SC-008 generous budget).
 *
 * Idempotent: the dialog target email uses `Date.now()` so each run
 * creates a unique invitee, and `afterEach` revokes it (which deletes the
 * pending row), so runs leave nothing behind.
 */
import { expect, fillField, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

// Post-cutover (2026-08-11) this flow belongs to a SUPER admin: /admin/users
// is D4-narrowed to `users.manage` (a plain admin gets the 404 shell before any
// button exists), and inviting a STAFF role trips the same gate server-side
// (T059). The spec pre-dated RBAC v2 and kept signing in as plain admin, so it
// timed out on a page that no longer opens for that persona.
const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;

test.describe('invite-flow wall-clock (T119, SC-008)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_SUPER_ADMIN_EMAIL and E2E_SUPER_ADMIN_PASSWORD to run the invite flow',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  // Every run used to leave its `invitee-<ms>@swecham.test` pending invite
  // behind (24 had piled up on the dev DB by 2026-10-13). They sort to the top
  // of /admin/users, so other specs met fake invites first: a /invite/i
  // selector matched their "More actions for invitee-…" buttons, and
  // destructive-confirm exercised Revoke instead of Disable. Revoke the one
  // this run created, even when an assertion after the 201 failed.
  let invitedUserId: string | null = null;
  test.afterEach(async ({ page }) => {
    if (!invitedUserId) return;
    const res = await page.request.post(`/api/auth/users/${invitedUserId}/revoke-invite`, {
      headers: { Origin: new URL(page.url()).origin },
    });
    invitedUserId = null;
    expect(res.status(), 'revoking the invite this run created').toBe(200);
  });

  test('a super_admin invites a manager via the dialog and completes under 300 s', async ({
    page,
  }) => {
    const startWallClock = Date.now();

    // Sign in
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    // Navigate to users page
    await page.goto('/admin/users');
    await page.waitForLoadState('networkidle');

    // Click the "Invite user" CTA that opens the dialog
    await page.getByRole('button', { name: /invite/i }).click();

    // Dialog should open — email field becomes visible
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const inviteeEmail = `invitee-${Date.now()}@swecham.test`;
    await fillField(dialog.getByLabel(/email/i), inviteeEmail);

    // Select manager role via the Base UI combobox (button, not native <select>)
    await dialog.getByLabel(/role/i).click();
    await page.getByRole('option', { name: /manager/i }).click();

    // Submit → wait for the 201
    const [inviteResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/auth/invite') &&
          r.request().method() === 'POST',
        { timeout: 15_000 },
      ),
      dialog.getByRole('button', { name: /send|submit|invit/i }).last().click(),
    ]);

    expect(inviteResponse.status()).toBe(201);
    invitedUserId = ((await inviteResponse.json()) as { user: { id: string } }).user.id;

    // Dialog closes on success
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Wall-clock check
    const elapsed = (Date.now() - startWallClock) / 1000;
    console.log(`  invite-flow: admin-side completed in ${elapsed.toFixed(1)}s`);
    expect(elapsed).toBeLessThan(300);
  });
});
