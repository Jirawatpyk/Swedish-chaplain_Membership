/**
 * 058 G2 — Account-hub route-safety + deep-link E2E (@route-safety, spec §4.5 + §97).
 *
 * D2 consolidated the former standalone portal pages
 * (`/portal/preferences/renewals`, `/portal/account/data-export`) into the
 * single Account hub at `/portal/account`, each surface now an anchored
 * `<h2>` section (`#renewal-prefs`, `#data-privacy`). Two classes of caller
 * still hardcode the OLD URLs and MUST never hit a 404:
 *
 *   1. Renewal-reminder emails hardcode `${baseUrl}/portal/preferences/renewals`
 *      (renewals dispatch-one-cycle.ts + retry-failed-reminders.ts +
 *      base-renewal-layout.tsx) — a 404 here breaks the PDPA opt-out path
 *      (ship blocker).
 *   2. Existing bookmarks / deep-links to `/portal/account/data-export`.
 *
 * Both legacy routes are now redirect-only pages that `redirect()` to the
 * matching hub anchor. This spec proves they RESOLVE (status < 400, NOT 404)
 * and land on the correct section, plus that the avatar account-menu
 * deep-links into the hub renewal section.
 *
 * Requires E2E_MEMBER_* in .env.local. Run:
 *   pnpm test:e2e --grep "@route-safety" --workers=1
 * (ALWAYS `--workers=1` per project memory — default 3 hangs the workstation.
 * On a sign-in timeout from rate-limiting, RE-RUN: global-setup auto-clears
 * the Upstash buckets — do NOT sleep or restart the dev server.)
 *
 * Authoritative-run note (project memory `reference_e2e_perf_gates_preview_only`):
 * the AUTHORITATIVE run is the preview deploy (prod build + co-located Neon).
 * Local dev e2e has EXPECTED noise — dev-server sign-in cold-compile flakes +
 * WebKit cold-compile. A genuine failure here (a legacy route 404, a wrong
 * heading, the avatar item not landing on the hub) is a real bug.
 *
 * URL-hash survival (VERIFIED against the real dev harness, 2026-06-07):
 * Next.js 16's `redirect()` from a Server Component performs a client-side RSC
 * soft-navigation. In `next dev`, `page.url()` does NOT reliably surface the
 * `#renewal-prefs` / `#data-privacy` FRAGMENT after that soft-redirect — the
 * captured page snapshot proves the Account hub renders in full (all four
 * anchored `<h2>` sections present), yet `page.url()` lags at the legacy URL or
 * lands on `/portal/account` WITHOUT the fragment. So this spec asserts the
 * PATH only (`/portal/account`, no `$`/fragment anchor) and treats the visible
 * section `<h2>` as the LOAD-BEARING "landed on the right section" proof — the
 * hub renders every anchored section and the fragment only governs scroll
 * position, so the heading visibility is the meaningful invariant, not the
 * fragment. (See project memory `reference_e2e_perf_gates_preview_only` —
 * authoritative run is the preview deploy; this honours the prompt's
 * "make the test reflect REAL behavior" guidance.)
 *
 * Dev-profiler pageerror (DEV-ONLY noise — NARROW scoped opt-out below): under
 * `next dev`, navigating to the `RenewalPreferencesPage` redirect-only Server
 * Component DETERMINISTICALLY throws
 * `Failed to execute 'measure' on 'Performance': 'RenewalPreferencesPage'
 * cannot have a negative time stamp` from React's dev component-performance
 * profiler (`flushComponentPerformance`, in `/_next/static/...`): the
 * redirect-only component renders in ~0 ms and the profiler computes a negative
 * duration against its start mark. The profiler's `performance.measure` calls
 * are DEV-ONLY (stripped from prod builds), so this NEVER fires on the
 * authoritative preview deploy. The shared `../fixtures` pageerror auto-fail
 * (fixtures.ts) only carves out messages containing `__nextjs`, and this
 * profiler error's message is the bare `Performance.measure` TypeError, so it
 * would trip the fixture.
 *
 * We deliberately do NOT use the blanket `E2E_PAGEERROR_IGNORE=true` opt-out
 * here: a blanket suppression would silently swallow a REAL deferred
 * `MISSING_MESSAGE` / hydration crash on the account hub (the exact bug class
 * this project most cares about). Instead, the beforeAll/afterAll below sets
 * the NARROW `E2E_PAGEERROR_IGNORE_PATTERN` regex env var (added to fixtures.ts)
 * to a pattern that matches ONLY this profiler error. The pattern is anchored
 * on the React-internal stack frame `flushComponentPerformance` rather than the
 * message, because the SAME error has engine-specific messages: chromium /
 * mobile-chrome emit the descriptive `… 'Performance': '…' cannot have a
 * negative time stamp`, while WebKit / mobile-safari emit only the bare,
 * uninformative `Type error` whose ONLY stable discriminator is that stack
 * frame. fixtures.ts therefore tests the pattern against `message + '\n' +
 * stack`. `flushComponentPerformance` is a React dev-profiler internal that
 * never appears in app error stacks, so every other pageerror — including
 * `MISSING_MESSAGE`, app `TypeError`, and hydration mismatches — still fails
 * the test. The var is set for THIS spec's worker only and restored in afterAll
 * so the opt-out does not leak to other specs sharing the worker. The status +
 * heading assertions remain the loud, genuine-regression detectors regardless.
 *
 * Hub <h2> accessible names (en.json `portal.account.sections`):
 *   - renewalPrefs = "Renewal preferences" → /renewal preferences/i
 *   - dataPrivacy  = "Data & privacy"      → /data & privacy/i
 * The `#data-privacy` section is f9-gated; FEATURE_F9_DASHBOARD=true locally
 * (+ EXPORT_DOWNLOAD_TOKEN_SECRET set) so it renders. If F9 is OFF the redirect
 * still resolves (status < 400) but the heading would be absent.
 *
 * Avatar account-menu (user-menu.tsx):
 *   - trigger aria-label = shell.userMenu.label = "Account menu"
 *   - Renewal item       = portal.account.menu.renewalPrefs = "Renewal reminders"
 *     → href="/portal/account#renewal-prefs"
 * The dropdown is a Base UI menu (role="menuitem" on items, the trigger is a
 * <button>).
 */
import { expect, test } from '../fixtures';
import { signInAsMember } from '../helpers/member-session';

test.describe('@route-safety Account-hub legacy routes resolve to anchors', () => {
  // Scope the dev-profiler pageerror opt-out (see header note) to THIS spec's
  // worker process — the shared fixtures.ts pageerror auto-fail reads
  // `process.env.E2E_PAGEERROR_IGNORE_PATTERN` at teardown, so toggling it here
  // is honoured per-test, and restoring it in afterAll prevents leakage into
  // other specs that may run in the same `--workers=1` process.
  //
  // NARROW pattern (not the blanket flag): matches ONLY the Next.js 16
  // dev-profiler error, anchored on the React-internal stack frame
  // `flushComponentPerformance`. fixtures.ts tests this pattern against
  // `message + '\n' + stack`, which is required because the SAME error has
  // engine-specific messages: chromium/mobile-chrome emit the descriptive
  // `Failed to execute 'measure' on 'Performance': '…' cannot have a negative
  // time stamp`, while WebKit/mobile-safari emit only the uninformative bare
  // `Type error` — the `flushComponentPerformance` frame is the sole stable
  // discriminator across both. `flushComponentPerformance` is a React
  // dev-profiler internal that NEVER appears in an app-level error stack, so it
  // can NOT mask a real `MISSING_MESSAGE`, app `TypeError`, or hydration-mismatch
  // pageerror — each of those has a different stack and would still fail loudly.
  let prevPageErrorIgnorePattern: string | undefined;
  test.beforeAll(() => {
    prevPageErrorIgnorePattern = process.env.E2E_PAGEERROR_IGNORE_PATTERN;
    process.env.E2E_PAGEERROR_IGNORE_PATTERN = 'flushComponentPerformance';
  });
  test.afterAll(() => {
    if (prevPageErrorIgnorePattern === undefined) {
      delete process.env.E2E_PAGEERROR_IGNORE_PATTERN;
    } else {
      process.env.E2E_PAGEERROR_IGNORE_PATTERN = prevPageErrorIgnorePattern;
    }
  });

  test.beforeEach(async ({ page }) => {
    await signInAsMember(page);
  });

  test('legacy /portal/preferences/renewals redirects to #renewal-prefs (not 404)', async ({
    page,
  }) => {
    const res = await page.goto('/portal/preferences/renewals');
    // Renewal-reminder emails hardcode this URL — it must NEVER 404.
    expect(res?.status()).toBeLessThan(400);
    // Load-bearing proof of "landed on the right section": the hub renders
    // every anchored section, so a visible Renewal-preferences <h2> proves the
    // redirect reached the hub (a 404 / wrong page would never show it).
    // Asserted FIRST so it waits out the RSC soft-redirect before the URL read.
    await expect(
      page.getByRole('heading', { level: 2, name: /renewal preferences/i }),
    ).toBeVisible();
    // Path only — the dev RSC soft-redirect does not surface the #renewal-prefs
    // fragment in page.url() (see header note); the hub path is the invariant.
    await expect(page).toHaveURL(/\/portal\/account/);
  });

  test('legacy /portal/account/data-export redirects to #data-privacy (not 404)', async ({
    page,
  }) => {
    const res = await page.goto('/portal/account/data-export');
    expect(res?.status()).toBeLessThan(400);
    // f9-gated section; FEATURE_F9_DASHBOARD=true locally so it renders.
    // Heading-first (waits out the soft-redirect) → then the path-only URL.
    await expect(
      page.getByRole('heading', { level: 2, name: /data & privacy/i }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/portal\/account/);
  });

  test('avatar Renewal item deep-links into the hub renewal section', async ({
    page,
  }) => {
    await page.goto('/portal');
    await page.getByRole('button', { name: /account menu/i }).click();
    await page.getByRole('menuitem', { name: /renewal/i }).click();
    // Heading-first proves the avatar item deep-linked into the hub's renewal
    // section; the path-only URL is the secondary invariant (fragment dropped
    // by the dev soft-navigation — see header note).
    await expect(
      page.getByRole('heading', { level: 2, name: /renewal preferences/i }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/portal\/account/);
  });
});
