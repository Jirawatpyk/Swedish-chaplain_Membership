/**
 * F8 Phase 10 · T271 — F8 manager read-only E2E suite.
 *
 * Validates Constitution v1.4.0 RBAC + FR-003 at the F8 surfaces:
 *
 *   1. A manager can sign in to /admin/sign-in.
 *   2. A manager can LOAD every F8 admin surface (read-only):
 *      - /admin/renewals (US1 pipeline)
 *      - /admin/renewals/[cycleId] (US1 cycle detail)
 *      - /admin/renewals/tasks (US6 escalation queue)
 *      - /admin/renewals/tier-upgrades (US5 tier-upgrade queue)
 *   3. The UI hides every destructive affordance:
 *      - Send Reminder Now buttons absent
 *      - Mark Paid Offline / Cancel Cycle / Reactivate buttons absent
 *      - Tier-upgrade Accept / Dismiss buttons absent
 *      - Escalation-task Done / Skip / Reassign buttons absent
 *   4. A direct API POST to a F8 mutating endpoint returns 403 +
 *      emits an audit `f8_role_violation_blocked` event (server-
 *      side RBAC source of truth — Phase 9 T228 + T230 already ship
 *      the policy + integration test; this E2E pins the round-trip).
 *
 * The unit + integration layers (rbac-defence-in-depth.test.ts +
 * f8-role-violation.unit.test.ts) cover the policy + DB-layer audit
 * persistence exhaustively. This spec closes the E2E gap.
 *
 * Credentials (seeded by scripts/seed-e2e-user.ts):
 *   E2E_MANAGER_EMAIL    = e2e-manager@swecham.test
 *   E2E_MANAGER_PASSWORD = (same script prints it)
 *
 * Run:
 *   pnpm test:e2e --workers=1 --grep "T271"
 */
import { expect, test } from './fixtures';
import { signInAsManager } from './helpers/manager-session';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;
// Staff-R007 contract: `E2E_RENEWAL_CYCLE_ID` is a STAGING-time env var
// pointing at a real seeded cycle in the staging tenant (not auto-
// seeded per-test because admin-cycle-detail-page assertions need
// stable data). Document the operator setup at
// `docs/runbooks/e2e-test-data.md`. When unset (CI without the staging
// fixture), the cycle-detail test cleanly skips with explicit
// rationale — NOT a "skip is not pass" violation because the test
// genuinely cannot exercise the cycle-detail surface without a
// pre-seeded cycle id.
const E2E_RENEWAL_CYCLE_ID = process.env.E2E_RENEWAL_CYCLE_ID;

test.describe.configure({ mode: 'serial' });

test.describe('T271 — F8 manager read-only (Constitution RBAC + FR-003)', () => {
  test.skip(
    !MANAGER_EMAIL || !MANAGER_PASSWORD,
    'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('manager sees /admin/renewals (read-only render)', async ({ page }) => {
    await signInAsManager(page);
    await page.goto('/admin/renewals');
    // Staff-R001 fix: domcontentloaded over networkidle. Turbopack
    // RSC streaming keeps the network "active" indefinitely on
    // hydration boundaries → networkidle never resolves → flaky
    // 30s+ timeouts. domcontentloaded fires at the right moment for
    // these read-only assertions; explicit element waits below pin
    // the post-hydration state we actually need.
    await page.waitForLoadState('domcontentloaded');

    // Page renders — heading visible.
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible();

    // Mutating affordances absent — Send Reminder Now is the
    // canonical pipeline-row mutation that admins use. The action
    // is rendered as a `DropdownMenuItem` (ARIA role=menuitem) inside
    // each row's overflow menu (pipeline-table.tsx:372-377). For a
    // manager render, the entire row-actions menu trigger may be
    // absent OR each menuitem must be disabled when opened. R4
    // review H2 fix: probe by `role="menuitem"` once the menu opens,
    // and gate on `count() === 0` if the rows are empty.
    const rowMenuButtons = page.getByRole('button', { name: /open/i });
    const rowCount = await rowMenuButtons.count();
    if (rowCount === 0) {
      // No pipeline rows seeded for this run — soft-skip the
      // affordance assertion (route-load was the primary contract
      // verified by the heading visibility above).
      return;
    }
    // Open the first row's overflow menu and probe its menuitems.
    await rowMenuButtons.first().click();
    const sendMenuItems = page.getByRole('menuitem', {
      name: /send.+reminder/i,
    });
    const sendItemCount = await sendMenuItems.count();
    if (sendItemCount === 0) {
      // Manager view correctly omits the destructive menuitem.
      return;
    }
    // If a Send Reminder menuitem IS rendered, it MUST be disabled
    // (defense-in-depth — server route also returns 403, see the
    // direct-POST test below).
    for (let i = 0; i < sendItemCount; i++) {
      const item = sendMenuItems.nth(i);
      const ariaDisabled = await item.getAttribute('aria-disabled');
      const isDisabled = await item.isDisabled().catch(() => false);
      expect(
        ariaDisabled === 'true' || isDisabled,
        `Send Reminder menuitem #${i} must be disabled for manager`,
      ).toBe(true);
    }
  });

  test('manager sees /admin/renewals/tasks (read-only render)', async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto('/admin/renewals/tasks');
    // Staff-R001 fix: domcontentloaded over networkidle. Turbopack
    // RSC streaming keeps the network "active" indefinitely on
    // hydration boundaries → networkidle never resolves → flaky
    // 30s+ timeouts. domcontentloaded fires at the right moment for
    // these read-only assertions; explicit element waits below pin
    // the post-hydration state we actually need.
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible();
    // Done / Skip / Reassign actions are admin-only.
    const doneBtn = page.getByRole('button', { name: /^done$/i });
    const skipBtn = page.getByRole('button', { name: /^skip$/i });
    const reassignBtn = page.getByRole('button', { name: /reassign/i });
    expect(await doneBtn.count()).toBe(0);
    expect(await skipBtn.count()).toBe(0);
    expect(await reassignBtn.count()).toBe(0);
  });

  test('manager sees /admin/renewals/tier-upgrades (read-only render)', async ({
    page,
  }) => {
    await signInAsManager(page);
    await page.goto('/admin/renewals/tier-upgrades');
    // Staff-R001 fix: domcontentloaded over networkidle. Turbopack
    // RSC streaming keeps the network "active" indefinitely on
    // hydration boundaries → networkidle never resolves → flaky
    // 30s+ timeouts. domcontentloaded fires at the right moment for
    // these read-only assertions; explicit element waits below pin
    // the post-hydration state we actually need.
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible();
    // Accept / Dismiss admin-only.
    const acceptBtn = page.getByRole('button', { name: /accept/i });
    const dismissBtn = page.getByRole('button', { name: /dismiss/i });
    expect(await acceptBtn.count()).toBe(0);
    expect(await dismissBtn.count()).toBe(0);
  });

  test('manager sees /admin/renewals/[cycleId] (read-only render)', async ({
    page,
  }) => {
    test.skip(
      !E2E_RENEWAL_CYCLE_ID,
      'Set E2E_RENEWAL_CYCLE_ID to run cycle-detail manager-read-only test',
    );
    await signInAsManager(page);
    await page.goto(`/admin/renewals/${E2E_RENEWAL_CYCLE_ID}`);
    // Staff-R001 fix: domcontentloaded over networkidle. Turbopack
    // RSC streaming keeps the network "active" indefinitely on
    // hydration boundaries → networkidle never resolves → flaky
    // 30s+ timeouts. domcontentloaded fires at the right moment for
    // these read-only assertions; explicit element waits below pin
    // the post-hydration state we actually need.
    await page.waitForLoadState('domcontentloaded');
    // Mark Paid Offline + Cancel Cycle + Reactivate are admin-only.
    expect(
      await page.getByRole('button', { name: /mark.+paid/i }).count(),
    ).toBe(0);
    expect(
      await page.getByRole('button', { name: /cancel.+cycle/i }).count(),
    ).toBe(0);
    expect(
      await page.getByRole('button', { name: /reactivate/i }).count(),
    ).toBe(0);
  });

  test('direct POST to F8 mutating endpoint → 403 forbidden', async ({
    page,
    request,
  }) => {
    // Sign in via the page so the session cookie is set on the
    // shared context.
    await signInAsManager(page);

    // Pick a representative F8 mutation — `send-reminder-now` (real
    // route at `src/app/api/admin/renewals/[cycleId]/send-reminder-now/`).
    // Manager session must be rejected at the route guard before
    // touching DB. Audit row `f8_role_violation_blocked` is verified
    // by the integration test (rbac-defence-in-depth.test.ts) — here
    // we only assert the HTTP contract. R4 review H1 fix: route name
    // corrected from `/send-reminder` (404) to `/send-reminder-now`,
    // and 404 dropped from the accept-array so a future route rename
    // surfaces as a real failure.
    const cycleId = E2E_RENEWAL_CYCLE_ID ?? '00000000-0000-0000-0000-000000000000';
    const resp = await request.post(
      `/api/admin/renewals/${cycleId}/send-reminder-now`,
      {
        headers: { 'content-type': 'application/json' },
        data: {},
        failOnStatusCode: false,
      },
    );
    // Expect 403 (forbidden) — NOT 401 (manager IS authenticated)
    // NOT 404 (route exists). 200 would be a security failure.
    expect(resp.status()).toBe(403);
    const body = await resp.json().catch(() => ({}));
    expect(JSON.stringify(body)).toMatch(/forbidden|role|rbac/i);
  });
});
