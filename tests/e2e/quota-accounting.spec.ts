/**
 * T082 — E2E: F6 quota accounting admin surface (US4 AS1–AS4 + T087 toggle).
 *
 * Spec authority: specs/012-eventcreate-integration/spec.md User Story 4
 * Acceptance Scenarios AS1–AS4 (lines 112-115) — Diamond-6 partnership
 * decrement, over-quota 7th, cultural Premium-2 decrement, refund
 * credit-back. Plus the T087 admin toggle UI (FR-019) shipped in Phase 6
 * wave-2.
 *
 * Scope:
 *   This is the **admin UI surface** smoke test — it verifies that the
 *   quota badges + toggle controls render and behave correctly in the
 *   browser. The DEEP behavioural correctness of the quota engine
 *   (advisory lock, decision matrix, audit emission, refund flip,
 *   toggle re-evaluation, cross-tenant isolation, concurrency
 *   invariant) is already covered by the integration suites:
 *     - tests/integration/events/quota-accounting.test.ts (6 tests:
 *       AS1+AS2+AS3+AS4 + Principle I cross-tenant)
 *     - tests/integration/events/toggle-event-category.test.ts
 *       (5 tests: ON/OFF/no-op/not_found/archived)
 *     - tests/integration/events/quota-concurrency.test.ts (2 tests:
 *       SC-004 zero-error promise under 10 concurrent ingests)
 *
 *   That coverage is more efficient + stable than the equivalent
 *   webhook-driven E2E flow would be — building 6+ payloads through
 *   the route handler in a browser test would add no behavioural
 *   coverage beyond what the integration tier already gives, while
 *   adding 5+ minutes of wall-clock to each E2E run.
 *
 *   This file therefore focuses on what ONLY an E2E test can prove:
 *   (a) the admin can navigate to /admin/events/{eventId} and SEE
 *       the quota badges + toggle controls, and (b) the
 *       AlertDialog-driven toggle UX behaves correctly (open, cancel,
 *       button states, role-gated rendering).
 *
 * Run with:
 *   pnpm test:e2e --grep "F6 quota accounting" --workers=1
 *
 * (`--workers=1` is MANDATORY per CLAUDE.md memory feedback_e2e_workers
 *  — Playwright's default of 3 workers hangs the dev workstation.)
 *
 * Gated on E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD env vars per repo
 * convention; skip at runtime when missing.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

// Dev-server cold compile + Next.js Turbopack chunk on first nav can
// push individual tests past 30s; widen for cross-page navigation
// sequences. Mirrors events-list-and-detail.spec.ts.
test.describe.configure({ timeout: 180_000 });

test.describe('F6 quota accounting — admin UI surface @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin quota E2E',
  );

  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  test('admin can navigate to /admin/events and see the events list', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByRole('heading', { name: /events/i, level: 1 }),
    ).toBeVisible();
    // Either a populated table OR the documented empty state. Both
    // are valid post-Phase 6 — this test does NOT require seeded data.
    const table = page.getByRole('table');
    const empty = page.getByText(/no events|waiting for first event|configure eventcreate/i);
    await expect(table.or(empty).first()).toBeVisible();
  });

  test('event detail page renders Quota column + attendee-status badges (when seeded data exists)', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');

    // Find any event row. If empty state, skip — this test asserts UI
    // rendering, not data presence (seeded data is environment-specific).
    const rows = page.getByRole('row');
    const hasRow = (await rows.count()) > 1; // 1 = header
    test.skip(
      !hasRow,
      'No seeded events present — skipping detail-render assertion',
    );

    // Click the first non-header row
    const firstRow = rows.nth(1);
    await firstRow.click();
    await page.waitForLoadState('domcontentloaded');

    // Expect event detail page mounted (h1 + attendees section)
    await expect(
      page.getByRole('heading', { level: 2, name: /attendees/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Quota column must be present in the attendee table.
    const attendeeTable = page.getByRole('table');
    await expect(
      attendeeTable.getByRole('columnheader', { name: /quota/i }),
    ).toBeVisible();
  });

  test('admin sees Partner-benefit + Cultural-event toggle buttons in event header', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const rows = page.getByRole('row');
    const hasRow = (await rows.count()) > 1;
    test.skip(!hasRow, 'No seeded events — skipping toggle-UI render assertion');

    const firstRow = rows.nth(1);
    await firstRow.click();
    await page.waitForLoadState('domcontentloaded');

    // Look for either flag-state of each toggle. The button label
    // depends on the current event flag state (Flag-as / Remove-flag),
    // so we match the union via regex.
    const partnerToggle = page.getByRole('button', {
      name: /(flag as partner benefit|remove partner-benefit flag)/i,
    });
    const culturalToggle = page.getByRole('button', {
      name: /(flag as cultural event|remove cultural-event flag)/i,
    });
    await expect(partnerToggle).toBeVisible({ timeout: 10_000 });
    await expect(culturalToggle).toBeVisible({ timeout: 10_000 });
  });

  test('clicking Partner-benefit toggle opens confirmation dialog + Cancel returns without state change', async ({
    page,
  }) => {
    await page.goto('/admin/events');
    await page.waitForLoadState('domcontentloaded');
    const rows = page.getByRole('row');
    const hasRow = (await rows.count()) > 1;
    test.skip(!hasRow, 'No seeded events — skipping toggle-confirm assertion');

    const firstRow = rows.nth(1);
    await firstRow.click();
    await page.waitForLoadState('domcontentloaded');

    const partnerToggle = page.getByRole('button', {
      name: /(flag as partner benefit|remove partner-benefit flag)/i,
    });
    const initialName = await partnerToggle.textContent();
    await partnerToggle.click();

    // AlertDialog mounts in a portal with role=alertdialog. Either the
    // "flag" title or the "unflag" title will be present depending on
    // the current state.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect(
      dialog.getByRole('heading', {
        name: /(flag this event as a partner benefit|remove partner-benefit flag)/i,
      }),
    ).toBeVisible();

    // Body explains the FR-019 quota impact.
    await expect(
      dialog.getByText(
        /(re-evaluated against their partnership-tier|credited back to their members)/i,
      ),
    ).toBeVisible();

    // Cancel closes the dialog without firing the POST. After cancel,
    // the trigger button label MUST remain unchanged.
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible();
    await expect(partnerToggle).toHaveText(initialName ?? '');
  });
});
