/**
 * F8 Phase 5 Wave E · T151 — lapsed-portal-scope E2E (FR-005a).
 *
 * Coverage scope: smoke-test that the whitelisted F8 portal surfaces
 * (renewal page, preferences page) are reachable for an authenticated
 * member. The full FR-005a "lapsed-blocked" branch is NOT exercised
 * via E2E because:
 *
 *   - `cyclesRepo.findActiveForMember` excludes status='lapsed'
 *     (schema convention) — the helper cannot detect a lapsed-only
 *     member without a schema-level adjustment (Wave D follow-up).
 *   - Unit-test coverage at
 *     `tests/unit/lib/lapsed-portal-scope.test.ts` (16/16 PASS)
 *     exercises every blocking branch with an in-memory mock cycle
 *     repo returning a lapsed cycle directly.
 *
 * E2E here verifies the routes themselves render (no 404 / 500 /
 * proxy 503 from the F8 kill-switch path) for the e2e-member fixture.
 */
import { expect } from './fixtures';
import { memberTest as test } from './helpers/member-session';
import { seedF8Renewals } from './helpers/renewals-seed';

test.describe('F8 — lapsed-portal-scope smoke (T151 / FR-005a)', () => {
  test('whitelisted routes render: /portal/preferences/renewals + /portal/renewal/[memberId]', async ({
    page,
  }) => {
    // Constitution Principle VI: throw on missing prerequisites instead
    // of skipping so env-config gaps surface as hard failures.
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'F8 renewals seed returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }

    // Whitelist 1 — preferences page should render the toggle.
    await page.goto('/portal/preferences/renewals');
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { name: /renewal reminders/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('switch')).toBeVisible();

    // Whitelist 2 — renewal page renders for the active cycle.
    await page.goto(`/portal/renewal/${seed.memberId}`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { name: /online renewal/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
