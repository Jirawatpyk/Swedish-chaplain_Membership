/**
 * F8 Phase 5 Wave E · T151 — lapsed-portal-scope E2E (FR-005a).
 *
 * Coverage scope: smoke-test that the whitelisted F8 portal surfaces
 * (renewal page, renewal opt-out) are reachable for an authenticated
 * member. Since 058 D2 the legacy `/portal/preferences/renewals` route
 * 308-redirects to the consolidated Account hub
 * (`/portal/account#renewal-prefs`); the opt-out toggle lives there now.
 * The full FR-005a "lapsed-blocked" branch is NOT exercised
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

    // Whitelist 1 — the renewal opt-out surface must stay reachable.
    //
    // 058 D2: `/portal/preferences/renewals` now 308-redirects to the
    // consolidated Account hub (`/portal/account#renewal-prefs`) — the
    // FR-016 opt-out toggle moved there. The redirect target is itself
    // lapsed-allow-listed (LAPSED_PORTAL_ALLOWED_PREFIXES includes
    // '/portal/account' in src/lib/lapsed-portal-scope.ts), so a lapsed
    // member still lands on the opt-out (FR-005a). We assert the hub's
    // real section heading "Renewal preferences" (en.json
    // portal.account.sections.renewalPrefs) — NOT the legacy "Renewal
    // reminders" page title, which the hub no longer renders as a heading.
    await page.goto('/portal/preferences/renewals');
    await page.waitForLoadState('networkidle');
    const renewalSection = page.locator('#renewal-prefs');
    await expect(
      renewalSection.getByRole('heading', {
        level: 2,
        name: /renewal preferences/i,
      }),
    ).toBeVisible({ timeout: 15_000 });
    // RenewalRemindersToggle renders the single switch in this section
    // (ThemeToggle elsewhere on the hub is a dropdown, not a switch).
    // Scope to #renewal-prefs to keep the assertion robust if a future
    // hub section adds another switch.
    await expect(renewalSection.getByRole('switch')).toBeVisible();

    // Whitelist 2 — renewal page renders for the active cycle.
    await page.goto(`/portal/renewal/${seed.memberId}`);
    await page.waitForLoadState('networkidle');
    await expect(
      page.getByRole('heading', { name: /online renewal/i }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
