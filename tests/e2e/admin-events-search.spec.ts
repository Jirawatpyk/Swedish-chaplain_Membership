/**
 * R3-T2 + R3-T3 (2026-05-18 /speckit-review Round 3 Final) — Playwright
 * e2e for the F6.1 events list search toolbar.
 *
 * Coverage:
 *   R3-T2: the box shows the URL's `?q=`, and clearing it strips `q`.
 *     Spec 122 US9a: the list's filters follow the one filter pattern
 *     (docs/aura-adoption.md § Filters) and write the URL in place
 *     (`router.replace`), so Back leaves the list instead of replaying each
 *     search, as on every migrated list.
 *   R3-T3: the filter bar's polite result count (AURA FilterBar, which
 *     replaced the page's hidden `<output role="status">`) reflects the
 *     filtered result count after a search.
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD env vars per repo
 * convention; skip at runtime when missing.
 *
 * Run with: pnpm test:e2e --grep "F6.1 events search" --workers=1
 * (--workers=1 is mandatory per CLAUDE.md memory feedback_e2e_workers).
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ timeout: 180_000 });

test.describe('F6.1 events search toolbar — R3-T2 + R3-T3 @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin events search e2e',
  );

  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test('R3-T2 — the box follows `?q=`; clearing strips it in place', async ({
    page,
  }) => {
    // 1. Goto a URL with `?q=` pre-set. The server renders with
    //    search="midsummer" and the filter bar shows the value.
    await page.goto('/admin/events');
    await page.goto('/admin/events?q=midsummer');
    await page.waitForLoadState('domcontentloaded');

    const searchInput = page.getByRole('searchbox', { name: /search events/i });
    await expect(searchInput).toHaveValue('midsummer');

    // 2. Clear the box. The fill is retried until the URL write lands (a fill
    //    before hydration clears the box and writes nothing), and the
    //    assertion demands that `q` is GONE (2026-09-10 lesson: a regex that
    //    also matched `?q=midsummer` made this step vacuous).
    await expect(async () => {
      await searchInput.fill('');
      await expect(page).not.toHaveURL(/[?&]q=/, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/admin\/events(?:\?|$)/);
    await expect(searchInput).toHaveValue('');

    // 3. The clear replaced the history entry: Back goes to the list as it
    //    was opened before the search, not to `?q=midsummer`.
    await searchInput.blur();
    await page.goBack();
    await page.waitForLoadState('domcontentloaded');
    await expect(page).toHaveURL(/\/admin\/events$/);
  });

  test('R3-T3 — live-region announces the result count after submit', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');

    // The live region is the filter bar's result count (spec 122 US9a:
    // AURA FilterBar's polite count replaced the page's hidden
    // `<output role="status">`). It exists from page load.
    const liveRegion = page.locator('.aura-filterbar__count').first();
    await expect(liveRegion).toBeAttached();

    // Type a substring + submit via Enter.
    const searchInput = page.getByRole('searchbox', { name: /search events/i });
    await searchInput.fill('midsummer');
    await searchInput.press('Enter');

    // The page re-renders server-side with the filtered count. The
    // live-region's text becomes the i18n message
    // `resultsAnnouncementWithQuery({count, query})`. We don't pin
    // the exact count (depends on seed data) — just that the live
    // region contains the substring "midsummer" (the query echo).
    await expect(liveRegion).toContainText(/midsummer/);
  });

  test('R3-T3 — live-region announces zero-result state without query', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');

    const liveRegion = page.locator('.aura-filterbar__count').first();
    await expect(liveRegion).toBeAttached();

    // Without any query, the live-region renders the
    // `resultsAnnouncement({count})` form. The count varies by seed,
    // so we assert the region has SOME text content (not empty).
    const text = await liveRegion.textContent();
    expect(text).toBeTruthy();
    expect((text ?? '').trim().length).toBeGreaterThan(0);
  });

  test('R4-T2 — Clear filters click returns focus to search input (WCAG 2.4.3)', async ({
    page,
  }) => {
    // R3-F5 added `queueMicrotask(() => searchInputRef.current?.focus())`
    // inside the Clear filters callback. This e2e verifies the focus
    // landing target end-to-end — keyboard users need predictable
    // focus return after the empty-state container unmounts.
    //
    // Strategy: load an event-detail page with a guaranteed-empty
    // filter (`?q=__r4_t2_nomatch_marker__`), find the Clear filters
    // button in the empty-state, click it, then assert
    // `document.activeElement` matches the search input.
    //
    // This test depends on a SEEDED event being present in the test
    // tenant. Skip if no event id is available in the env.
    const eventId = process.env.E2E_ADMIN_EVENT_ID;
    test.skip(
      !eventId,
      'Set E2E_ADMIN_EVENT_ID to a seeded event UUID to run R4-T2 focus-return e2e',
    );
    await page.goto(
      `/admin/events/${eventId}?q=__r4_t2_nomatch_marker__`,
    );
    await page.waitForLoadState('domcontentloaded');

    // Empty-state should render with a Clear filters button. (The filter
    // bar's own "Clear filters" comes first, since the search is a chip;
    // the empty state's button is the last one.)
    const clearButton = page
      .getByRole('button', {
        name: /clear filters/i,
      })
      .last();
    await expect(clearButton).toBeVisible();

    // Capture the search input. The attendee-table search input has
    // aria-label `t('admin.events.detail.attendees.searchLabel')`
    // which renders to "Search attendees" in EN.
    const searchInput = page.getByRole('searchbox', {
      name: /search attendees/i,
    });
    await expect(searchInput).toBeVisible();

    // Click Clear filters + wait for the URL transition.
    await clearButton.click();
    await expect(page).toHaveURL(
      new RegExp(`/admin/events/${eventId}(?:\\?|$)`),
    );

    // Focus must have returned to the search input. queueMicrotask
    // schedules the focus after React's commit; Playwright's
    // `expect.toBeFocused()` polls until the assertion passes or
    // times out.
    await expect(searchInput).toBeFocused();
  });
});
