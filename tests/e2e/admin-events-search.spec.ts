/**
 * R3-T2 + R3-T3 (2026-05-18 /speckit-review Round 3 Final) — Playwright
 * e2e for the F6.1 events list search toolbar.
 *
 * Coverage:
 *   R3-T2 (R2-2a useEffect prop-sync): Browser Back/Forward changes
 *     the URL `?q=` and the input value updates to match.
 *   R3-T3 (R2-2b live-region): The `<output role="status"
 *     aria-live="polite">` text content reflects the filtered result
 *     count after a search submit.
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

  test('R3-T2 — back navigation re-populates search input from URL `?q=`', async ({
    page,
  }) => {
    // 1. Goto a URL with `?q=` pre-set. The server renders with
    //    initialSearch="midsummer", the client toolbar mounts and
    //    shows the value.
    await page.goto('/admin/events?q=midsummer');
    await page.waitForLoadState('domcontentloaded');

    const searchInput = page.getByRole('searchbox', { name: /search events/i });
    await expect(searchInput).toHaveValue('midsummer');

    // 2. Click the native browser X clear button by emulating an
    //    onChange to empty — the toolbar's onChange handler strips
    //    `?q=` from the URL.
    await searchInput.fill('');
    // Wait for the server transition to complete (URL change).
    await expect(page).toHaveURL(/\/admin\/events(?:\?|$)/);
    await expect(searchInput).toHaveValue('');

    // 3. Browser Back — URL returns to `?q=midsummer` and the input
    //    value MUST re-populate to "midsummer". Pre-R2-2a the input
    //    stayed empty (stale local state); R2-2a useEffect prop-sync
    //    + R3-U2 focus-guard fixes this.
    await page.goBack();
    await page.waitForLoadState('domcontentloaded');
    await expect(searchInput).toHaveValue('midsummer');
  });

  test('R3-T3 — live-region announces the result count after submit', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');

    // The live-region is rendered as `<output role="status">` inside
    // the events list page (admin/events/page.tsx). It exists from
    // page load.
    const liveRegion = page.getByRole('status').first();
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

    const liveRegion = page.getByRole('status').first();
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

    // Empty-state should render with a Clear filters button.
    const clearButton = page.getByRole('button', {
      name: /clear filters/i,
    });
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
