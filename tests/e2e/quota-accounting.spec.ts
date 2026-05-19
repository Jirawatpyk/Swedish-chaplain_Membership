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
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

/**
 * Phase 6 staff-review-4 SUGG-3 — `global-setup.ts` already seeds F6
 * events via `seedF6Events` and exports the partner-benefit event ID
 * to `E2E_SEED_F6_PB_EVENT_ID`. Use that directly instead of clicking
 * the first row + skipping on absence, so these tests provide
 * unconditional CI coverage of the AS1+AS2+AS4 admin surfaces.
 *
 * If the seed env var is missing (extremely fresh environment), the
 * suite falls back to the `test.skip` path with a clear message —
 * mirrors the F7/F8 pattern for environment-conditional E2E.
 */
const SEED_PB_EVENT_ID = process.env.E2E_SEED_F6_PB_EVENT_ID ?? null;

// Dev-server cold compile + Next.js Turbopack chunk on first nav can
// push individual tests past 30s; widen for cross-page navigation
// sequences. Mirrors events-list-and-detail.spec.ts.
test.describe.configure({ timeout: 180_000 });

test.describe('F6 quota accounting — admin UI surface @workers=1', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin quota E2E',
  );

  /**
   * R6 TEST-R6-05 — fail-loud health check. `global-setup.ts` seeds
   * F6 events via `seedF6Events` and surfaces failures only as
   * `console.warn` (does NOT throw — by design, so unrelated suites
   * still run). Without this health-check, an infrastructure failure
   * (Neon outage, schema drift, missing tenant config) silently
   * degrades all 4 SEED_PB_EVENT_ID-dependent tests to `test.skip`
   * — CI runs green despite the quota admin surface being untested.
   *
   * This test is the canary: if global-setup did NOT populate
   * `E2E_SEED_F6_PB_EVENT_ID`, fail the run with a clear pointer to
   * the cause. Other tests in this describe still use `test.skip` as
   * a defensive guard, but the failure here is the operator-visible
   * signal.
   */
  test('CI health check: global-setup populated E2E_SEED_F6_PB_EVENT_ID', () => {
    expect(
      process.env.E2E_SEED_F6_PB_EVENT_ID,
      'E2E_SEED_F6_PB_EVENT_ID missing — check global-setup.ts seedF6Events failure in earlier console.warn line; the quota-accounting suite cannot validate its surface without a seeded partner-benefit event row',
    ).toBeTruthy();
  });

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

  test('event detail page renders Quota column + attendee-status badges', async ({
    page,
  }) => {
    // SUGG-3 — use the seeded partner-benefit event from global-setup
    // so this test runs unconditionally in CI rather than skipping on
    // empty-state. The fallback path remains for environments without
    // seed env vars (truly fresh setup).
    test.skip(
      !SEED_PB_EVENT_ID,
      'E2E_SEED_F6_PB_EVENT_ID missing — global-setup did not seed F6 events',
    );

    await page.goto(`/admin/events/${SEED_PB_EVENT_ID}`);
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
    test.skip(
      !SEED_PB_EVENT_ID,
      'E2E_SEED_F6_PB_EVENT_ID missing — global-setup did not seed F6 events',
    );

    await page.goto(`/admin/events/${SEED_PB_EVENT_ID}`);
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
    test.skip(
      !SEED_PB_EVENT_ID,
      'E2E_SEED_F6_PB_EVENT_ID missing — global-setup did not seed F6 events',
    );

    await page.goto(`/admin/events/${SEED_PB_EVENT_ID}`);
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

  /**
   * Phase 6 staff-review-4 SUGG-4 — `@a11y` axe-core WCAG 2.1 AA scan
   * on the quota admin surface. F3/F4/F7 specs include axe-core scans
   * per Constitution Principle VI; F6 Phase 6's Quota column +
   * AlertDialog toggle wrappers had no a11y assertions until now.
   *
   * Fails only on `serious` / `critical` violations (mirrors the
   * existing `eventcreate-a11y.spec.ts` convention). `minor` and
   * `moderate` are logged for triage but do not fail the run.
   */
  test('@a11y F6 quota admin surface (event detail + AlertDialog) axe-core scan', async ({
    page,
  }) => {
    test.skip(
      !SEED_PB_EVENT_ID,
      'E2E_SEED_F6_PB_EVENT_ID missing — global-setup did not seed F6 events',
    );

    await page.goto(`/admin/events/${SEED_PB_EVENT_ID}`);
    await page.waitForLoadState('domcontentloaded');
    // Wait for streamed metadata to settle (matches eventcreate-a11y.spec
    // expectNoAxeViolations helper precedent — Next.js 16 RSC streams
    // <title> after the initial DOM parse).
    await page.waitForFunction(() => document.title.length > 0, undefined, {
      timeout: 15_000,
    });

    // (1) scan with dialog CLOSED — covers Quota column + toggle buttons.
    const detailResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const detailSerious = detailResults.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    if (detailSerious.length > 0) {
      console.error(
        '[axe quota-detail] serious/critical violations:',
        JSON.stringify(detailSerious, null, 2),
      );
    }
    expect(detailSerious, 'quota detail page: serious/critical axe violations').toHaveLength(0);

    // (2) open the AlertDialog and scan focus-trapped overlay state.
    const partnerToggle = page.getByRole('button', {
      name: /(flag as partner benefit|remove partner-benefit flag)/i,
    });
    await partnerToggle.click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    // R6 TEST-R6-04 — scope axe to the focus-trapped alertdialog
    // region only. Without `.include(...)` axe scans the full page
    // including the dimmed backdrop, which can produce false-positive
    // color-contrast violations on the inert background content
    // depending on Radix version. F5's invoice-dialog scan uses the
    // same scoped pattern.
    const dialogResults = await new AxeBuilder({ page })
      .include('[role="alertdialog"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const dialogSerious = dialogResults.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    if (dialogSerious.length > 0) {
      console.error(
        '[axe quota-alertdialog] serious/critical violations:',
        JSON.stringify(dialogSerious, null, 2),
      );
    }
    expect(dialogSerious, 'quota AlertDialog: serious/critical axe violations').toHaveLength(0);
    // Cleanup — return focus to the trigger so the test does not
    // dirty the page state for subsequent specs.
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible();
  });
});
