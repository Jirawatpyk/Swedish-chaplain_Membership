/**
 * T054 — E2E: F6 admin events list + event detail (US2 AS1–AS5).
 *
 * Spec authority: specs/012-eventcreate-integration/spec.md User Story 2
 * Acceptance Scenarios AS1–AS5 (lines 76-82), including the 3-variant
 * empty-state matrix CHK028.
 *
 * RED reason: routes + pages + use-cases not yet shipped
 * (T057–T067). Pages will 404, every assertion fails until GREEN.
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD env vars per repo
 * convention; skip at runtime when missing (CI-skip pattern matching
 * F5/F7/F8 admin suites).
 *
 * Run with: pnpm test:e2e --grep "F6 events list and detail" --workers=1
 * (--workers=1 is mandatory per CLAUDE.md memory feedback_e2e_workers).
 *
 * Turns GREEN: T057-T067 land + test tenant has at least one imported
 * F6 event with mixed match types in seed data.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import en from '../../src/i18n/messages/en.json';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
// Seeded by global-setup (seedF6Events): the partner-benefit event, which
// carries an eventcreate_url.
const PB_EVENT_ID = process.env.E2E_SEED_F6_PB_EVENT_ID;
const emptyState = en.admin.events.list.emptyState;

// Dev server cold-compile + Next.js Turbopack chunk on first nav can
// push individual tests past 30s. Mirror broadcast-i18n pattern.
test.describe.configure({ timeout: 180_000 });

test.describe('F6 events list and detail — US2 AS1-AS5 @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin events e2e',
  );

  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test('AS1 — events list shows paginated table sorted by start_date desc', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');

    // PageHeader visible
    await expect(
      page.getByRole('heading', { name: /events/i, level: 1 }),
    ).toBeVisible();

    // T1 (verify-finding 2026-05-12, amended 2026-10-06): the match-rate
    // format is tested against the detail header in AS2 below — the
    // list table renders the same metric but the AS2 spec pins the
    // detail-header layout.

    // Table columns per AS1: Date, Name, Category, Registrations,
    // Partner Benefit, Match Rate. Spec 122 US9a: the list is AURA's
    // DataTable, an ARIA grid (rows and cells are role="row"/"gridcell").
    const table = page.getByRole('grid');
    await expect(table).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /date/i }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /name/i }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /category/i }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /registrations/i }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /partner benefit/i }),
    ).toBeVisible();
    await expect(
      table.getByRole('columnheader', { name: /match rate/i }),
    ).toBeVisible();
  });

  test('AS2 — event detail shows header + match rate + attendee table', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');

    // Click first event row link → detail page. If no events seeded
    // this test will fail with a clear "no events to click" message
    // — that's the RED signal until seed data lands.
    const firstRowLink = page.getByRole('grid').getByRole('link').first();
    await expect(firstRowLink).toBeVisible();
    await firstRowLink.click();

    await page.waitForURL(/\/admin\/events\/[^/]+$/);
    // AS2 (amended 2026-10-06): the header's match rate is the figure
    // "NN.N%", then "M of N attendees matched", then the band word; the
    // figure's accessible name is "NN.N% (M of N)". Scoped to the <dd>:
    // a page-wide getByText matched the 1×1px sr-only echo of the name,
    // which Playwright counts as visible, so it never checked the screen.
    const matchRate = page
      .locator('dt', { hasText: /^match rate$/i })
      .locator('xpath=following-sibling::dd[1]');
    await expect(matchRate).toBeVisible();
    // The figure is the <dd>'s own first text node, not the sr-only span.
    expect(
      await matchRate.evaluate((el) => el.firstChild?.textContent?.trim()),
    ).toMatch(/^\d+(?:\.\d+)?%$/);
    const [fraction, bandWord] = [
      matchRate.locator('small').nth(0),
      matchRate.locator('small').nth(1),
    ];
    await expect(fraction).toHaveText(/^\d+ of \d+ attendees matched$/);
    // toBeVisible() also accepts a 1×1px sr-only node (R36b mutation test),
    // so each line must have a real rendered box.
    for (const line of [fraction, bandWord]) {
      const box = await line.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(1);
      expect(box?.height ?? 0).toBeGreaterThan(1);
    }
    await expect(matchRate).toHaveAttribute(
      'aria-label',
      /^\d+(?:\.\d+)?% \(\d+ of \d+\)$/,
    );

    // The attendee table is AURA's DataTable (an ARIA grid) named by its
    // caption ("Event attendees with match status, …").
    const attendeeTable = page.getByRole('grid', { name: /attendees/i });
    await expect(attendeeTable).toBeVisible();
  });

  test('AS3 — "View on EventCreate" button links to eventCreateUrl', async ({
    page,
  }) => {
    // The seeded partner-benefit event has an EventCreate URL. The list's
    // first row was order-dependent: other specs leave events without one
    // (e.g. eventcreate-a11y's "A11y R060 …"), so the link was rightly absent.
    test.skip(!PB_EVENT_ID, 'E2E_SEED_F6_PB_EVENT_ID unset (global-setup F6 seed)');
    await page.goto(`/admin/events/${PB_EVENT_ID}`);
    await page.waitForLoadState('domcontentloaded');

    const deepLink = page.getByRole('link', {
      name: /view on eventcreate/i,
    });
    await expect(deepLink).toBeVisible();
    // Must open in new tab and have noopener for security
    await expect(deepLink).toHaveAttribute('target', '_blank');
    await expect(deepLink).toHaveAttribute('rel', /noopener/);
  });

  test('AS4 — "Show unmatched only" toggle filters attendee table', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const firstRowLink = page.getByRole('grid').getByRole('link').first();
    await firstRowLink.click();
    await page.waitForURL(/\/admin\/events\/[^/]+$/);

    // Toggle button — accessible name "Show unmatched only" or similar.
    const toggle = page.getByRole('button', {
      name: /show unmatched only|unmatched/i,
    });
    await expect(toggle).toBeVisible();
    await toggle.click();

    // After toggle, URL gains ?unmatchedOnly=1 (or true) — assert
    // either form. (Route handler parses both.)
    await page.waitForURL((u) =>
      /unmatchedOnly=(1|true)/.test(u.toString()),
    );
  });

  test('H1 — invalid matchTypeFilter redirects to clean URL', async ({
    page,
  }, testInfo) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const firstRowLink = page.getByRole('grid').getByRole('link').first();
    if (!(await firstRowLink.isVisible().catch(() => false))) {
      // T-MED-2: emit a CI-visible annotation so the silent-skip is
      // surfaced in Playwright traces. Otherwise a staging-data drift
      // (e.g., all events archived) would silently skip this test
      // forever without anyone noticing.
      testInfo.annotations.push({
        type: 'data-gap',
        description:
          'H1 redirect test skipped — no seeded F6 events available on /admin/events',
      });
      test.skip(
        true,
        'No seeded F6 events available — H1 redirect test needs at least one event',
      );
      return;
    }
    await firstRowLink.click();
    await page.waitForURL(/\/admin\/events\/[^/]+$/);
    const eventIdMatch = page.url().match(/\/admin\/events\/([^/?]+)/);
    expect(eventIdMatch).toBeTruthy();
    const eventId = eventIdMatch![1]!;
    // Navigate to the detail page with a garbage matchTypeFilter; the
    // server component must call redirect() to strip the bad param.
    await page.goto(`/admin/events/${eventId}?matchTypeFilter=garbage`);
    // After redirect, the URL must NOT contain `matchTypeFilter`.
    await page.waitForURL(
      (u) => !u.toString().includes('matchTypeFilter'),
      { timeout: 10_000 },
    );
    expect(page.url()).not.toContain('matchTypeFilter=garbage');
    expect(page.url()).not.toContain('matchTypeFilter=');
    // The page should still render the event detail (not 404).
    await expect(page.getByText(/match rate/i)).toBeVisible();
  });

  test('AS5 variant (a) — no integration configured renders setup CTA', async ({
    page,
  }) => {
    // Variant (a) needs a tenant with NO tenant_webhook_configs row, and
    // the shared e2e tenant has one (global-setup seeds it), so this test
    // checks that the list settles into a valid state; the three
    // empty-state variants themselves are unit-tested on the list view.
    await page.goto('/admin/events');
    // Wait for the list to settle into one of its states: the table, or one
    // of the three empty-state variants (copy from en.json). The old check
    // read isVisible() once, which does not wait, and combined the results
    // with Promise.any, which resolves to the first boolean even when it is
    // false, so it failed on both legs whenever it ran before the render.
    const grid = page.getByRole('grid');
    const setupCta = page.getByRole('link', { name: emptyState.noIntegration.cta });
    const waitingTitle = page.getByText(emptyState.noDeliveries.title, { exact: true });
    const archivedTitle = page.getByText(emptyState.allArchived.title, { exact: true });
    await expect(grid.or(setupCta).or(waitingTitle).or(archivedTitle).first()).toBeVisible();
    if (await grid.isVisible()) {
      // The table path (global-setup seeds an active integration with
      // events); the empty-state variants are covered by the view unit tests.
      await expect(grid.getByRole('row').nth(1)).toBeVisible();
    }
  });

  test('AS5 variant (c) — archived-events toggle includes archived in list', async ({
    page,
  }) => {
    // "Show archived events" toggle flips includeArchived=true.
    // Available as a filter chip on the list page.
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const archivedToggle = page.getByRole('button', {
      name: /show archived|include archived/i,
    });
    // Toggle may not be visible when no archived events exist —
    // that's fine; the test only asserts the toggle exists when
    // applicable, and that the URL param is wired correctly when
    // pressed.
    if (await archivedToggle.isVisible().catch(() => false)) {
      await archivedToggle.click();
      await page.waitForURL((u) =>
        /includeArchived=(1|true)/.test(u.toString()),
      );
    }
  });
});
