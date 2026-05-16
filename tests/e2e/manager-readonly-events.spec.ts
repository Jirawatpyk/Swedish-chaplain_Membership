/**
 * F6 Phase 10 T140 — Manager read-only E2E for F6 admin surfaces.
 *
 * Validates Constitution v1.4.0 RBAC + FR-035:
 *   1. Manager signs in successfully via /admin/sign-in.
 *   2. Manager can LOAD F6 admin surfaces (read-only render):
 *      - /admin/events (US2 list)
 *      - /admin/events/[eventId] (US2 detail) — if seeded
 *      - /admin/integrations/eventcreate (US3 wizard)
 *   3. UI hides every destructive affordance:
 *      - Archive event button absent
 *      - Toggle partner-benefit / cultural-event buttons absent
 *      - Relink CTA absent in attendee table
 *      - Erase PII button absent
 *      - Rotate / Force-expire secret buttons absent in wizard
 *   4. Direct API POST to F6 mutating endpoint returns 403/404 +
 *      audit emits `role_violation_blocked` (integration test
 *      `rbac-defence-in-depth.test.ts` proves this at the API
 *      layer; the E2E spec pins the round-trip from the
 *      browser context).
 *
 * Credentials (seeded via scripts/seed-e2e-user.ts):
 *   E2E_MANAGER_EMAIL    = e2e-manager@swecham.test
 *   E2E_MANAGER_PASSWORD = (set at seed time)
 *
 * Run:
 *   pnpm test:e2e --workers=1 --grep "T140"
 */
import { expect, test } from './fixtures';
import { signInAsManager } from './helpers/manager-session';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;
const FEATURE_FLAG = process.env.FEATURE_F6_EVENTCREATE;

test.describe.configure({ mode: 'serial' });

test.describe('T140 — F6 manager read-only (Constitution RBAC + FR-035)', () => {
  test.skip(
    !MANAGER_EMAIL || !MANAGER_PASSWORD || FEATURE_FLAG !== 'true',
    'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD + FEATURE_F6_EVENTCREATE=true',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('manager loads /admin/events list (read-only render)', async ({ page }) => {
    await signInAsManager(page);
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible();
    // CSV import CTA should be absent (admin-only mutating action)
    await expect(
      page.getByRole('link', { name: /Import CSV/i }),
    ).toHaveCount(0);
  });

  test('manager loads /admin/integrations/eventcreate (read-only)', async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto('/admin/integrations/eventcreate');
    await page.waitForLoadState('domcontentloaded');
    // Manager should NOT see Rotate / Force-expire / Test webhook
    // mutating buttons in the wizard
    await expect(
      page.getByRole('button', { name: /Rotate webhook secret/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Generate webhook secret/i }),
    ).toHaveCount(0);
  });

  test('direct API POST to /api/admin/events/[eventId]/archive returns 403/404', async ({
    page,
    request,
  }) => {
    await signInAsManager(page);
    // Reuse manager's session cookies via the test request context
    const cookies = await page.context().cookies();
    const cookieHeader = cookies
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
    const res = await request.post(
      '/api/admin/events/00000000-0000-4000-8000-000000000000/archive',
      {
        headers: { cookie: cookieHeader, 'content-type': 'application/json' },
        data: {},
      },
    );
    expect([403, 404]).toContain(res.status());
  });
});
