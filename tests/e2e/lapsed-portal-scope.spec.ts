/**
 * F8 Phase 5 Wave E · T151 — lapsed-portal-scope E2E (FR-005a).
 *
 * 059-membership-suspension Task 10 rewrite — the ORIGINAL version of this
 * spec (see git history) could only smoke-test the ALLOW side: the legacy
 * `cyclesRepo.findActiveForMember` the old `checkLapsedPortalScope` used
 * excluded `status='lapsed'` by construction, so the "member is lapsed"
 * branch could never fire against a real DB row — only an in-memory unit
 * mock could ever hand it one. `e2e-member` in that version was never
 * ACTUALLY terminated, so every assertion below would have passed
 * vacuously even if the deny-by-default allowlist were deleted entirely.
 *
 * This is fixed now: `deriveMembershipAccess` + `findLatestCycleForMember`
 * (Tasks 1-2) let a real `lapsed` row actually resolve to `terminated`, and
 * `seedTerminatedMember()` (./helpers/terminated-member-seed.ts) mints
 * exactly that state for `e2e-member`. This spec now exercises BOTH sides
 * of `checkPortalAccess`'s terminated policy against a genuinely
 * terminated member:
 *
 *   - ALLOW: `/portal/preferences/renewals` (→ Account hub renewal-prefs
 *     section, unaffected by cycle payability) stays reachable.
 *   - ALLOW (with a caveat): `/portal/renewal/[memberId]` is not blocked
 *     BY THE GATE (`/portal/renewal` is on `LAPSED_PORTAL_ALLOWED_
 *     PREFIXES`) — but the page's OWN downstream logic (`findActiveFor
 *     Member`) finds no active/payable cycle for a lapsed-only member and
 *     redirects to `/portal` itself (Task 9 report). That is a SEPARATE,
 *     pre-existing, correct behaviour — not a suspension-gate bug — so we
 *     assert "not blocked with an error", not "renders the renewal form".
 *   - DENY: `/portal/timeline` (NOT on the allowlist — Task 3's own unit
 *     test names this exact route) redirects AWAY to the bare `/portal`
 *     dashboard, which renders the terminated "membership lapsed" /
 *     mailto-contact copy instead of the normal widgets.
 */
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';
import {
  seedTerminatedMember,
  type TerminatedMemberSeed,
} from './helpers/terminated-member-seed';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe('F8 — lapsed-portal-scope E2E (T151 / FR-005a) — terminated member', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD,
    'E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD not set',
  );

  let seed: TerminatedMemberSeed | null = null;

  test.beforeEach(async () => {
    seed = await seedTerminatedMember();
    if (!seed) {
      throw new Error(
        'seedTerminatedMember returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
  });

  test('ALLOW — whitelisted routes stay reachable for a genuinely terminated member', async ({
    page,
  }) => {
    await signInAsMember(page);

    // Whitelist 1 — the renewal opt-out surface must stay reachable.
    //
    // 058 D2: `/portal/preferences/renewals` now 308-redirects to the
    // consolidated Account hub (`/portal/account#renewal-prefs`) — the
    // FR-016 opt-out toggle moved there. The redirect target is itself
    // lapsed-allow-listed (`LAPSED_PORTAL_ALLOWED_PREFIXES` includes
    // '/portal/account' in src/lib/lapsed-portal-scope.ts), so a
    // terminated member still lands on the opt-out (FR-005a).
    await page.goto('/portal/preferences/renewals');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe('/portal/account');
    const renewalSection = page.locator('#renewal-prefs');
    await expect(
      renewalSection.getByRole('heading', {
        level: 2,
        name: /renewal preferences/i,
      }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(renewalSection.getByRole('switch')).toBeVisible();

    // Whitelist 2 — `/portal/renewal/[memberId]` is not blocked BY THE
    // GATE (it's an allowlisted prefix). A lapsed-only member has no
    // active/payable cycle, so the page's OWN logic redirects to
    // `/portal` — that is expected, pre-existing behaviour (Task 9
    // report), NOT a suspension-gate failure. Assert it lands on an
    // in-portal page (no error, no 4xx/5xx), not that the form renders.
    // `page.goto()` already follows the redirect chain and resolves once
    // the FINAL response's load event fires — `response`/`page.url()`
    // already reflect the destination here. Deliberately NOT also
    // awaiting `networkidle`: Next dev mode's persistent HMR websocket can
    // make that wait flaky/slow, and nothing below needs it (no rendered
    // text is asserted on this page, only the final pathname).
    const response = await page.goto(`/portal/renewal/${seed!.memberId}`);
    expect(response?.status() ?? 0).toBeLessThan(400);
    expect(new URL(page.url()).pathname.startsWith('/portal')).toBe(true);
  });

  test('DENY — a non-allowlisted route redirects to the bare dashboard', async ({
    page,
  }) => {
    await signInAsMember(page);

    // `/portal/timeline` is explicitly NOT on `LAPSED_PORTAL_ALLOWED_
    // PREFIXES` (tests/unit/lib/membership-suspension-policy.test.ts
    // asserts this directly) — a genuinely terminated member hitting it
    // must be redirected away, never shown the timeline content.
    await page.goto('/portal/timeline');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe('/portal');

    // Lands on the bare dashboard's TERMINATED presentation — the
    // "membership lapsed" card + mailto contact-support CTA (`portal.
    // dashboard.membership.lapsedValue`/`contactToRenew`), not the
    // normal widget set. Scoped to the FIRST StatCard (`(home)/page.tsx`
    // always renders `<MembershipStatSection>` first of the 3 stat
    // cards) rather than `data-variant="destructive"` alone: e2e-member's
    // seeded ISSUED invoice (scripts/seed-e2e-portal-invoices.ts) has a
    // past due date, so the UNRELATED Outstanding-balance card is ALSO
    // `variant="destructive"` (overdue) — `data-variant` alone is not
    // unique on this page, and the SAME "Membership lapsed" text renders
    // twice inside the Membership card itself (value + icon status row),
    // so any unscoped locator hits Playwright's strict-mode multi-match
    // error.
    const lapsedCard = page.locator('[data-testid="stat-card"]').first();
    await expect(lapsedCard).toHaveAttribute('data-variant', 'destructive');
    await expect(lapsedCard).toContainText(/membership lapsed/i);
    await expect(
      lapsedCard.getByRole('link', { name: /contact us to reactivate/i }),
    ).toBeVisible();
  });
});
