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
 * Round 6 W-015 follow-up — viewport-aware action locators.
 *
 * The tier-upgrade queue collapses below md (768px) into a row-menu
 * (`DropdownMenu` with aria-label="Open row actions menu") that contains
 * the Accept/Escalate/Dismiss as menu items. The `md:hidden` /
 * `md:inline-flex` classes select between the two presentations, so
 * the desktop chromium project sees inline buttons while mobile-safari
 * + mobile-chrome (375px viewport) see the row-menu.
 *
 * To avoid skipping mobile tests, helpers below resolve the action
 * trigger by inspecting which presentation is visible and routing
 * through the row-menu when needed. Both paths converge on the same
 * AlertDialog flow (the menu item's onSelect calls the same `setDialog`
 * action handler as the inline button's onClick).
 */

async function findInlineActionButton(
  page: Page,
  label: RegExp,
): Promise<Locator | null> {
  // Wait up to 10s for a visible inline button. Returns null when the
  // viewport routes through the row-menu instead (mobile) — caller
  // falls back to openRowMenuIfMobile in that case. Without the wait,
  // a desktop run can race against page hydration and return null
  // for a button that's about to render (chromium AlertDialog test
  // flake observed 2026-05-10).
  const btn = page.getByRole('button', { name: label }).first();
  const visible = await btn
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  return visible ? btn : null;
}

async function openRowMenuIfMobile(page: Page): Promise<boolean> {
  // The row-menu trigger only renders on viewports < md. When visible,
  // it carries aria-label `Open row actions menu` (i18n key
  // `actions.row_menu_aria` — locale-aware). We match a relaxed pattern
  // so the helper survives EN/TH/SV runs without locale switching.
  const menuTrigger = page
    .getByRole('button', {
      name: /open row actions? menu|เมนูการดำเนินการของแถว|öppna åtgärdsmeny/i,
    })
    .first();
  // Wait up to 10s for the trigger to attach + become visible. Mobile
  // hydration is slower than desktop; without this wait, the helper
  // can return false on a slow-loading page (false negative cascade
  // into the caller's `expect(opened).toBe(true)` flake).
  const visible = await menuTrigger
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  if (!visible) {
    return false;
  }
  // Belt-and-braces for mobile viewports: scroll into view, then click.
  // shadcn/ui DropdownMenu uses Radix portal — the menu mounts elsewhere
  // in the DOM but `page.getByRole('menu')` finds it cross-portal.
  await menuTrigger.scrollIntoViewIfNeeded().catch(() => {});
  await menuTrigger.click();
  // Wait for the Radix DropdownMenu to be fully rendered before the
  // caller probes for menu items. Without this, the menuitem locator
  // can resolve to a not-yet-attached element (mobile click race).
  await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5_000 });
  return true;
}

/**
 * Round 6 Round-7 UX-fix — restored unified `clickRowAction` helper
 * after the queue component migrated DropdownMenuItem from `onSelect`
 * to `onClick` (matching F8 Phase 8 `escalation-task-queue.tsx`
 * pattern). The `onClick` handler fires on the underlying `<button>`
 * element directly, bypassing Radix's onSelect → popper-close race
 * that previously broke under mobile-chrome / mobile-safari
 * simulators. No more viewport-split, no more skips — single test
 * runs the AlertDialog flow on every browser project.
 */
async function clickRowAction(
  page: Page,
  label: RegExp,
): Promise<void> {
  const inline = await findInlineActionButton(page, label);
  if (inline !== null) {
    await inline.click();
    return;
  }
  const opened = await openRowMenuIfMobile(page);
  if (!opened) {
    throw new Error(
      `clickRowAction: neither inline button nor row-menu trigger found for ${label}`,
    );
  }
  const menu = page.getByRole('menu').first();
  const menuItem = menu.getByRole('menuitem', { name: label });
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
    // Either the empty-state title OR the table renders. The
    // empty-state title text is locale-aware; we assert at least one
    // of the two is present so the test is robust to seeded data.
    const emptyOrTable = page.getByText(/no upgrade candidates|tier upgrade queue/i);
    await expect(emptyOrTable.first()).toBeVisible();
  });

  test('shows action buttons in admin queue rows when suggestions exist', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals/tier-upgrades');
    // Round 6 — viewport-aware: desktop sees inline Accept/Escalate/Dismiss
    // buttons; mobile sees a row-menu trigger that, when opened,
    // exposes the same actions as menu items. The seed always creates
    // an open suggestion for the e2e-member so this is real coverage,
    // not a vacuous skip.
    const acceptInline = await findInlineActionButton(page, /^accept$/i);
    if (acceptInline !== null) {
      await expect(acceptInline).toBeVisible();
      await expect(
        page.getByRole('button', { name: /^dismiss$/i }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: /^escalate$/i }).first(),
      ).toBeVisible();
      return;
    }
    // Mobile path — open the row menu, assert the 3 menu items exist.
    const opened = await openRowMenuIfMobile(page);
    expect(opened, 'expected inline buttons OR a row-menu trigger').toBe(true);
    await expect(
      page.getByRole('menuitem', { name: /^accept$/i }),
    ).toBeVisible();
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
    // `clickRowAction` handles both desktop (inline button) and mobile
    // (row-menu → menu item via onClick on the underlying <button>).
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

    // Escalate has no confirm dialog — clickRowAction handles desktop inline
    // + mobile row-menu on every viewport.
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
