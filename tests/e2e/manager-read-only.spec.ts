/**
 * T083 — Manager read-only E2E test (Playwright).
 *
 * Validates FR-003 + spec User Story 2 "manager views financial
 * reports without mutating data" at the UI layer:
 *
 *   1. A manager can sign in to the staff portal at /admin/sign-in.
 *   2. A manager can LOAD /admin/users (the read surface is visible
 *      to both admin and manager — FR-003 = RBAC on the action,
 *      not the route).
 *   3. The UI hides every destructive affordance from the manager:
 *      - No Disable buttons on any row (canDisable = isAdmin && …)
 *      - No Enable buttons on any row (canEnable = isAdmin && …)
 *      - The "Invite user" button is rendered DISABLED
 *   4. A direct POST /api/auth/invite as the manager's session is
 *      rejected with 403 `forbidden` (the API gate re-validates
 *      via requireRole — server-side RBAC is the source of truth).
 *
 * The unit + integration layers (`manager-readonly-policy.test.ts`
 * + `rbac-manager-readonly.test.ts`) already cover the policy and
 * API paths exhaustively. This spec closes the E2E gap: "when a
 * manager opens the page in a browser, are the buttons actually
 * absent / disabled, not just server-rejected on click?"
 *
 * Credentials:
 *   E2E_MANAGER_EMAIL    = e2e-manager@swecham.test (seeded by
 *                           `scripts/seed-e2e-user.ts`)
 *   E2E_MANAGER_PASSWORD = (same script prints it)
 */
import { expect, fillField, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('manager read-only staff portal (FR-003, User Story 2)', () => {
  test.skip(
    !MANAGER_EMAIL || !MANAGER_PASSWORD,
    'Set E2E_MANAGER_EMAIL and E2E_MANAGER_PASSWORD to run (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('manager sees /admin/users with zero destructive affordances', async ({ page }) => {
    // Sign in via the staff portal — same URL as admin (both roles
    // use /admin/sign-in). The RBAC policy runs after the sign-in,
    // at page/action load time.
    await page.goto('/admin/sign-in');
    await page.waitForLoadState('networkidle');

    await fillField(page.getByLabel(/email/i), MANAGER_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), MANAGER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Manager lands on /admin (staff home) — the same landing page
    // as an admin. The difference is entirely in which mutating
    // actions work once they navigate to a subsurface.
    await page.waitForURL('**/admin', { timeout: 10_000 });
    await expect(page).toHaveURL(/\/admin$/);

    // Navigate to the users list. Managers CAN read it (the
    // requireSession('staff') guard accepts both admin and manager);
    // they just cannot mutate.
    await page.goto('/admin/users');
    await page.waitForLoadState('networkidle');

    // The page should render — we expect the table heading and
    // refresh hint to be visible to a manager too.
    await expect(
      page.getByRole('heading', { level: 1, name: /users/i }),
    ).toBeVisible();

    // --- UI affordance assertions ---
    // 1. Zero Disable buttons on ANY row (canDisable = isAdmin && …).
    //    The button is rendered via {canDisable ? <Button /> : …} so
    //    there should be literally zero nodes with the Disable label.
    const disableButtons = page.getByRole('button', { name: /^disable$/i });
    await expect(disableButtons).toHaveCount(0);

    // 2. Zero Enable buttons on ANY row (canEnable = isAdmin && …).
    const enableButtons = page.getByRole('button', { name: /^enable$/i });
    await expect(enableButtons).toHaveCount(0);

    // 3. The Invite user button IS rendered (it's always mounted)
    //    but its `disabled` prop is bound to `!isAdmin`, so for a
    //    manager session it MUST be in the disabled state. We query
    //    by role='button' with the invite name and assert disabled.
    const inviteButton = page.getByRole('button', { name: /invite user/i });
    await expect(inviteButton).toBeVisible();
    await expect(inviteButton).toBeDisabled();

    // Sanity: the role badge in the top-right shows "manager" —
    // the UserMenu always surfaces the caller's role so we can
    // visually differentiate from an admin session in screenshots.
    await expect(page.getByText(/manager/i).first()).toBeVisible();
  });

  test('direct POST /api/auth/invite as manager session is rejected with 403', async ({
    page,
  }) => {
    // Sign in fresh — the `page` fixture is a new browser context
    // per test by default, so previous cookies are gone. Using
    // `page.request` (not the top-level `request` fixture) is
    // critical here: it shares the browser context's cookie jar,
    // so the session cookie set during sign-in travels with the
    // POST. The top-level `request` fixture has its own empty jar
    // and would return 401 (no session) instead of 403 (session
    // but RBAC denied) — which hides the bug we want to verify.
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), MANAGER_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), MANAGER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 10_000 });

    // Derive a same-origin Origin header from the current page URL.
    // CSRF allow-list rejects missing Origin on state-changing /api/*
    // requests (see src/lib/csrf.ts), so we MUST send one. In dev
    // mode the loopback pattern accepts any http://localhost:<port>.
    const pageUrl = new URL(page.url());
    const origin = `${pageUrl.protocol}//${pageUrl.host}`;

    // Fire a direct POST to /api/auth/invite with the manager's
    // session cookies attached (via page.request). The API route
    // gate (requireRole('auth:user', 'write')) MUST return 403
    // regardless of what the UI shows.
    const response = await page.request.post('/api/auth/invite', {
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
      },
      data: {
        email: `rbac-denied-${Date.now()}@swecham.test`,
        role: 'member',
      },
    });

    expect(response.status()).toBe(403);

    // The API emits a `manager_denied_write` audit event for this
    // exact path — verified at the integration layer by
    // `tests/integration/auth/rbac-manager-readonly.test.ts`. We
    // don't re-verify audit rows from an E2E to keep this spec
    // focused on the browser-visible contract.
  });
});
