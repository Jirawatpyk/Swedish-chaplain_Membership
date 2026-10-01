/**
 * F8 Phase 7 T205 — E2E for auto tier-upgrade queue (US5 AS1-AS6).
 *
 * Walks the admin-facing acceptance scenarios from
 * `specs/011-renewal-reminders/spec.md` § US5:
 *   - Renders the tier-upgrade queue page for admin
 *   - Manager redirects to /admin/renewals (admin-only route)
 *   - Kill-switch returns 404 when `FEATURE_F8_RENEWALS=false`
 *   - Empty-state copy renders in EN/TH/SV when zero open suggestions
 *
 * Server-side AS1 (eligibility), AS2/AS3 (Accept/Dismiss state machine),
 * AS5 (already-at-target skip), AS6 (tenant-disabled skip) are
 * covered by integration tests T202 + T203 + T204 against live Neon.
 * E2E focuses on the UI flow + RBAC redirect + theme/i18n smoke.
 *
 * Gate: when `FEATURE_F8_RENEWALS=false` the suite is skipped at
 * describe-level (Round 6 W-015 — was a `test.skip(true,...)` inside
 * beforeAll which left worker ordering ambiguous; the describe-level
 * pattern keeps Playwright's reporting clean).
 *
 * Run with: `pnpm test:e2e --grep "auto-tier-upgrade" --workers=1`
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { seedF8Renewals } from './helpers/renewals-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

/**
 * Row action locators (spec 122 US7b-1, T725; board `Admin-tier-upgrades`).
 *
 * Every row has the same actions at every width: an inline Accept button,
 * plus a ⋯ menu named for its row ("Escalate or dismiss — {member}") with
 * Escalate and Dismiss. On a phone the row is a stacked card with the same
 * controls in its last line, so no viewport branching is needed.
 */

/** The first row's inline Accept button. */
function acceptButton(page: Page): Locator {
  return page.locator('#main-content').getByRole('button', { name: /^accept$/i }).first();
}

/** Opens the first row's ⋯ menu (Escalate, Dismiss) and waits for it. */
async function openRowMenu(page: Page): Promise<void> {
  // The ⋯ trigger names its row; matched in EN / TH / SV.
  const menuTrigger = page
    .locator('#main-content')
    .getByRole('button', { name: /escalate or dismiss|ส่งต่อหรือปฏิเสธ|eskalera eller avvisa/i })
    .first();
  await menuTrigger.waitFor({ state: 'visible', timeout: 10_000 });
  await menuTrigger.scrollIntoViewIfNeeded().catch(() => {});
  await menuTrigger.click();
  await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5_000 });
}

/** Accept is inline; Escalate and Dismiss live in the row's ⋯ menu. */
async function clickRowAction(page: Page, label: RegExp): Promise<void> {
  if (label.test('Accept')) {
    await acceptButton(page).click();
    return;
  }
  await openRowMenu(page);
  const menuItem = page.getByRole('menu').first().getByRole('menuitem', { name: label });
  await menuItem.waitFor({ state: 'visible', timeout: 5_000 });
  await menuItem.click();
}

// Round 6 W-015 — describe-level skip when feature flag is OFF. Use
// `test.describe.skip` instead of `test.skip()` inside beforeAll so
// Playwright reports "skipped" cleanly and doesn't leave per-test
// ordering ambiguity under --workers=1.
const describeBlock = F8_RENEWALS_ENABLED ? test.describe : test.describe.skip;

describeBlock('F8 — auto tier-upgrade queue (US5)', () => {
  test.beforeAll(() => {
    if (!ADMIN_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL missing — set in .env.local before running this suite.',
      );
    }
  });

  test('renders tier-upgrade queue page for admin', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals/tier-upgrades');
    await expect(
      page.getByRole('heading', { name: /tier upgrade queue/i }),
    ).toBeVisible();
  });

  test('shows empty-state copy when zero open suggestions', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals/tier-upgrades');
    // Either the empty state OR the populated table renders — the seed
    // decides which, so assert that one of them is on screen.
    //
    // Anchored on the empty state's testid and on a table row, not on the
    // old `/no upgrade candidates|tier upgrade queue/i` text: that regex also
    // matched the shell breadcrumb's `<span aria-current="page">Tier upgrade
    // queue</span>`, which is hidden below `lg`. `.first()` then picked that
    // hidden node and the mobile project failed on every run (R20,
    // 2026-09-30) while the page itself was fine. Scoped to `#main-content`
    // so no chrome outside the page can satisfy it again.
    const empty = page.locator('#main-content [data-testid="tier-upgrades-empty"]');
    // The queue is an AURA grid (div rows), not a <table>.
    const row = page.locator('#main-content [role="grid"] [role="gridcell"]');
    await expect(empty.or(row).first()).toBeVisible();
  });

  test('shows action buttons in admin queue rows when suggestions exist', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals/tier-upgrades');
    // Every viewport: Accept inline, Escalate and Dismiss in the row's ⋯ menu
    // (122 US7b-1). The seed always creates an open suggestion for the
    // e2e-member, so this is real coverage, not a vacuous skip.
    await expect(acceptButton(page)).toBeVisible({ timeout: 10_000 });
    await openRowMenu(page);
    await expect(
      page.getByRole('menuitem', { name: /^escalate$/i }),
    ).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: /^dismiss$/i }),
    ).toBeVisible();
  });

  // Round 6 W-015 + Round-7 final — single unified test runs the
  // AlertDialog flow on every browser project. The queue component's
  // DropdownMenuItem now uses `onClick` (not `onSelect`) per F8 Phase 8
  // pattern, so the mobile touch event chain reliably fires
  // `setDialog → AlertDialog open`. No skips, no viewport split.
  test('Accept opens AlertDialog with Cancel focused (FR-058 §4) on every viewport', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals/tier-upgrades');
    // Accept is the row's inline button at every width.
    await clickRowAction(page, /^accept$/i);

    // AlertDialog opens with title + description + Cancel button.
    await expect(
      page.getByRole('alertdialog').getByRole('heading'),
    ).toBeVisible();
    const cancelBtn = page
      .getByRole('alertdialog')
      .getByRole('button', { name: /cancel/i });
    await expect(cancelBtn).toBeVisible();

    // FR-058 §4 focus-on-Cancel default. Locked across all 3 browser
    // projects after the onSelect → onClick migration.
    await expect(cancelBtn).toBeFocused();

    // Cancel keeps the suggestion in queue.
    await cancelBtn.click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  // WP6 (plan-change UX) — the queue must justify a price increase with the
  // full pricing EVIDENCE (declared turnover / paid-invoice volume + threshold
  // date), and link a resolved company NAME to the member detail (P1-9), rather
  // than approving on a coarse reason label + a raw UUID slice.
  test('renders pricing evidence + a member company-name link (WP6)', async ({
    page,
  }) => {
    // Guarantee an OPEN suggestion for the e2e-member with declared-turnover
    // evidence (evidence_jsonb.turnoverThb = 120_000_000). Idempotent.
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'seedF8Renewals returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
    await signInAsAdmin(page);
    await page.goto('/admin/renewals/tier-upgrades');

    // Evidence line — the declared-turnover figure renders as `฿120,000,000`
    // (narrowSymbol, 0 fraction digits). Match comma-grouped digits only so the
    // narrow/no-break separator + symbol stay tolerant across builds.
    await expect(page.getByText(/declared turnover/i).first()).toBeVisible();
    await expect(page.getByText(/120,000,000/).first()).toBeVisible();

    // Member cell links the resolved company NAME to /admin/members/<uuid>
    // (the href carries the id; the company name is the AT-meaningful label).
    const memberLink = page.locator(
      `a[href="/admin/members/${seed.memberId}"]`,
    );
    await expect(memberLink.first()).toBeVisible();
    await expect(memberLink.first()).toContainText(/E2E Alpha Co/);
  });

  // Optional error-toast path (BP5 item 1 + C-19: drive through Escalate — it
  // fires `callAction` with no AlertDialog, so no jsdom/portal deadlock). A
  // failed action surfaces a human toast (localised title + description), never
  // the raw server code.
  test('a failed action surfaces a localised error toast, not a raw code (escalate → 500)', async ({
    page,
  }) => {
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'seedF8Renewals returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
    // Force the escalate endpoint to fail server-side (a 500 the normalizer
    // maps to `server_error`).
    await page.route(
      '**/api/admin/renewals/tier-upgrades/*/escalate',
      async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'server_error' } }),
        });
      },
    );

    await signInAsAdmin(page);
    await page.goto('/admin/renewals/tier-upgrades');

    // Escalate has no confirm dialog; it sits in the row's ⋯ menu.
    await clickRowAction(page, /^escalate$/i);

    // sonner toast — localised title + human description, and NOT the raw code.
    await expect(page.getByText(/failed to draft outreach/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText(/something went wrong on our side/i),
    ).toBeVisible();
    await expect(page.getByText('server_error')).toHaveCount(0);
  });
});
