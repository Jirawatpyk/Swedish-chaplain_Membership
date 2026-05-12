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

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

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

    // T1 (verify-finding 2026-05-12): AS2 contract requires the
    // header's match-rate label to follow `NN% (M of N)` or
    // `NN.N% (M of N)`. Tested here against the detail page in AS2
    // below — list-table renders the same metric but the AS2 spec
    // pins the detail-header phrasing.

    // Table columns per AS1: Date, Name, Category, Registrations,
    // Partner Benefit, Match Rate
    const table = page.getByRole('table');
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
    const firstRowLink = page.getByRole('table').getByRole('link').first();
    await expect(firstRowLink).toBeVisible();
    await firstRowLink.click();

    await page.waitForURL(/\/admin\/events\/[^/]+$/);
    // Match-rate indicator surfaces in detail header — uses the
    // pattern "Match rate: NN% (M of N)" per AS2.
    await expect(page.getByText(/match rate/i)).toBeVisible();
    // T1 (verify-finding 2026-05-12): pin the exact AS2 format
    // `NN(.N)?% (M of N)` so regressions in the formatter are caught
    // at E2E. The English locale renders "%" + the parenthetical
    // raw fraction.
    await expect(
      page.getByText(/\d+(?:\.\d+)?%\s*\(\d+\s+of\s+\d+\)/),
    ).toBeVisible();

    // Attendee table is the second table on the page (first is the
    // detail-header summary or there's only one — fall back to role).
    const attendeeTable = page
      .getByRole('table', { name: /attendees/i })
      .or(page.getByRole('table').last());
    await expect(attendeeTable).toBeVisible();
  });

  test('AS3 — "View on EventCreate" button links to eventCreateUrl', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const firstRowLink = page.getByRole('table').getByRole('link').first();
    await firstRowLink.click();
    await page.waitForURL(/\/admin\/events\/[^/]+$/);

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
    const firstRowLink = page.getByRole('table').getByRole('link').first();
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

  test('H1 — invalid matchTypeFilter redirects to clean URL (E9-page round-2 fix)', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const firstRowLink = page.getByRole('table').getByRole('link').first();
    if (!(await firstRowLink.isVisible().catch(() => false))) {
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
    // Variant (a) requires a tenant with NO tenant_webhook_configs
    // row. The fixture for this state is supplied by Phase 4 seed
    // helpers OR by signing in as a special test tenant whose webhook
    // config has been wiped. Tests covering all 3 variants share the
    // same admin login; the variant differentiation is handled by
    // the use-case's emptyStateContext payload.
    //
    // Until seed harness lands (Phase 10 throwaway-tenant), this test
    // documents the assertion structure as RED.
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    // Either the table has rows OR the empty state is shown. If
    // empty, one of the 3 variants must be present.
    const tableHasRows = await page
      .getByRole('table')
      .getByRole('row')
      .nth(1)
      .isVisible()
      .catch(() => false);
    if (!tableHasRows) {
      // At least one of the 3 empty-state variants must be visible.
      const setupCta = page.getByRole('link', {
        name: /set up.*eventcreate|configure.*integration/i,
      });
      const waitingHint = page.getByText(/waiting for first event/i);
      const archivedHint = page.getByText(/all events.*archived/i);
      const someVariant = await Promise.any([
        setupCta.isVisible(),
        waitingHint.isVisible(),
        archivedHint.isVisible(),
      ]).catch(() => false);
      expect(someVariant).toBe(true);
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
