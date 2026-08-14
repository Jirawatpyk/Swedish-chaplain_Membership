/**
 * T083 — Manager read-only E2E test (Playwright).
 *
 * Validates FR-003 + spec User Story 2 "manager views financial
 * reports without mutating data" at the UI layer:
 *
 *   1. A manager can sign in to the staff portal at /admin/sign-in.
 *   2. Since 016 D4, `/admin/users` is `users.manage` = super_admin-ONLY —
 *      the manager (like a plain admin) gets the not-found shell, not a
 *      read-only render. The pre-016 claim this test used to make ("the
 *      read surface is visible, RBAC is on the action") is dead; the
 *      route IS the gate now.
 *   3. A direct POST /api/auth/invite as the manager's session is
 *      rejected with 403 `forbidden` (the API gate re-validates via
 *      `requireApiPermission('users.manage')` — server-side RBAC is the
 *      source of truth).
 *
 * Manager read-only AFFORDANCES on surfaces it still reaches are pinned
 * by the rbac-navigation persona walk (T062) and the user-list-table RTL
 * suite; this spec keeps only the browser-level route + API contracts.
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

  test('manager is denied /admin/users entirely (users.manage is super_admin-only)', async ({ page }) => {
    // Sign in via the staff portal — same URL as admin (both roles
    // use /admin/sign-in). The RBAC policy runs after the sign-in,
    // at page/action load time.
    await page.goto('/admin/sign-in');
    await page.waitForLoadState('networkidle');

    await fillField(page.getByLabel(/email/i), MANAGER_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), MANAGER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    // Manager lands on /admin (staff home) — the same landing page
    // as an admin. The difference is entirely in which subsurfaces
    // open once they navigate.
    await page.waitForURL('**/admin', { timeout: 10_000 });
    await expect(page).toHaveURL(/\/admin$/);

    // 016 D4: the users page gate is `requirePagePermission('users.manage')`
    // — super_admin-only. The manager stays a staff session (the layout
    // admits it) and the PAGE answers the not-found shell, never a
    // redirect and never a 5xx. Same strict idiom as the rbac persona
    // walks: `notFound()` is HTTP 200 on the dev server, so assert on
    // the not-found marker, not the status code alone.
    const res = await page.context().request.get('/admin/users', {
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    expect(res.status(), '/admin/users must not 5xx for a manager').toBeLessThan(500);
    expect([200, 404], '/admin/users must be a not-found, not a redirect').toContain(res.status());
    expect(await res.text()).toMatch(
      /<meta\s+name="next-error"\s+content="not-found"|NEXT_HTTP_ERROR_FALLBACK;404/,
    );
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
    // gate (requireApiPermission('users.manage')) MUST return 403
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

    // The API emits a `permission_denied` audit event for this exact
    // path — pinned by the denial-audit contract suite
    // (`tests/contract/rbac/permission-denied-audit.test.ts`). We
    // don't re-verify audit rows from an E2E to keep this spec
    // focused on the browser-visible contract.
  });
});
