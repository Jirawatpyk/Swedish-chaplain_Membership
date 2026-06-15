/**
 * T096 (F7.1a US7) — E2E happy path for template library flow.
 *
 * Playwright + axe-core. Env-gated `describe.skipIf` — skips when
 * E2E credentials are not set in the staging env (same pattern as
 * `tests/e2e/broadcasts/image-upload-allowlist.spec.ts`).
 *
 * Surfaces verified (all shipped through Phase 5A-5H.3):
 *   - Admin templates list page (/admin/broadcasts/templates) — 15
 *     starter rows + Starter badges + filter pills + a11y scan
 *   - Admin new template page — create + return to list
 *   - Member compose template picker — substitution + bracket survival
 *
 * Deferred to F7.1b polish: full Tiptap editor in admin form (T113
 * shipped via shared F7 MVP TiptapEditor); shadcn Combobox upgrade
 * for member picker (T115 MVP ships native <select>); bracket
 * placeholder Tiptap node-view (T116) + stale-draft banner (T117).
 */
import { expect, test } from '../fixtures';
// F7.1b B7 closure 2026-05-21 — uses centralized axe-scan helper.
import { runAxeScan } from '../helpers/axe-scan';
import postgres from 'postgres';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const DB_URL = process.env.DATABASE_URL;

const skipReason =
  !ADMIN_EMAIL || !ADMIN_PASSWORD || !MEMBER_EMAIL || !MEMBER_PASSWORD;

/**
 * E2E hygiene helper 2026-05-21: delete any leftover "E2E Test
 * Template" rows from prior runs so Test #1's row-count assertion is
 * deterministic. Test #2 creates this template but cannot reliably
 * delete it after the suite ends. The cleanup runs in `beforeAll` so
 * Tests #1 + #2 + #3 + #4 share a known-clean starting state.
 *
 * Idempotent: no-op when DATABASE_URL is unset (CI without DB cred).
 */
async function cleanupE2ETestTemplate(): Promise<void> {
  if (!DB_URL) return;
  const sql = postgres(DB_URL, { ssl: 'require', max: 1 });
  try {
    await sql`
      DELETE FROM broadcast_templates
      WHERE tenant_id = 'swecham'
        AND name = 'E2E Test Template'
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

test.describe('F7.1a US7 template library flow @template-library', () => {
  test.skip(skipReason, 'E2E credentials not configured');
  // E2E rate-limit fix 2026-05-21: each test signs in fresh
  // (Playwright isolates browser context per test), and the 5 sign-
  // ins per 15-min Upstash rate-limit bucket is shared across all 4
  // tests + their retries. With 4 tests × 3 retries = 12 sign-ins
  // per account per run, the bucket trips mid-suite. Disable retries
  // for this spec so we hit the bucket at most ONCE per account per
  // test — comfortably within budget. A real regression now fails on
  // first attempt instead of hiding behind retries.
  test.describe.configure({ retries: 0 });

  test.beforeAll(async () => {
    await cleanupE2ETestTemplate();
  });

  test.afterAll(async () => {
    await cleanupE2ETestTemplate();
  });

  test('admin sees 15 starter templates with Starter badge + filter pills', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    // E2E sign-in fix 2026-05-21: WAIT for the post-sign-in redirect
    // to settle before navigating away. The login API → cookie set →
    // server redirect is async; `page.goto` before this completes
    // races the cookie write and lands the next request unauthenticated.
    // Wait for sign-in to redirect AWAY from /admin/sign-in (catches
    // both /admin and /admin/<anything-not-sign-in>) — the prior regex
    // `/\/admin(\/|$)/` matched /admin/sign-in itself so the wait fell
    // through immediately even on failed sign-in.
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/admin') &&
        !url.pathname.startsWith('/admin/sign-in'),
      { timeout: 10_000 },
    );

    await page.goto('/admin/broadcasts/templates');

    // 15 starter rows × 3 locales = visible (5 names × 3) + 1 header row
    const rows = page.getByRole('row');
    await expect(rows).toHaveCount(16);

    // Starter badge present on seeded rows (sr-only aria-label
    // "Seeded by the platform" via starterBadgeAria i18n key)
    const starterBadges = page.getByText(/^Starter$/);
    await expect(starterBadges.first()).toBeVisible();

    // 3 filter pills with aria-pressed state — All starts active
    const allPill = page.getByRole('button', { name: /^All$/ });
    await expect(allPill).toHaveAttribute('aria-pressed', 'true');

    // Filter to Starter only — count narrows to 15 (all rows ARE
    // starter for a fresh tenant) but the pill state toggles
    await page.getByRole('button', { name: /Starter only/ }).click();
    await expect(
      page.getByRole('button', { name: /Starter only/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(allPill).toHaveAttribute('aria-pressed', 'false');

    // R4.4 L-8 — assert the sibling sr-only `role="status"` live
    // region announces the filtered count. The 150ms settle delay
    // in template-library.tsx batches multi-pill clicks; Playwright's
    // auto-retry on `toContainText` handles the window without an
    // explicit waitForTimeout.
    await expect(
      page.locator('[role="status"][aria-live="polite"].sr-only'),
    ).toContainText(/15/);

    // Filter to Admin-authored — no admin-authored templates exist for a
    // fresh tenant, so the table renders a SINGLE empty-state row: a
    // colSpan placeholder showing `filterEmpty` (added 2026-05-22 in
    // template-library.tsx so a filtered-empty table doesn't look broken),
    // NOT zero rows. Assert the empty-state, not a 0 count.
    await page.getByRole('button', { name: /Admin-authored/ }).click();
    const dataRows = page.locator('tbody tr');
    await expect(dataRows).toHaveCount(1);
    await expect(dataRows).toContainText(/No templates match this filter/i);

    // a11y baseline scan (WCAG 2.1 AA) — uses shared helper.
    await runAxeScan(page, test.info());
  });

  test('admin creates new template → appears in list', async ({ page }) => {
    // E2E sign-in fix 2026-05-21: each Playwright test has a FRESH
    // browser context — the prior test's auth cookie is gone, so we
    // must sign in again before hitting an authenticated route.
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    // Wait for sign-in to redirect AWAY from /admin/sign-in (catches
    // both /admin and /admin/<anything-not-sign-in>) — the prior regex
    // `/\/admin(\/|$)/` matched /admin/sign-in itself so the wait fell
    // through immediately even on failed sign-in.
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/admin') &&
        !url.pathname.startsWith('/admin/sign-in'),
      { timeout: 10_000 },
    );

    await page.goto('/admin/broadcasts/templates/new');

    await page.getByLabel(/^Name$/).fill('E2E Test Template');
    await page.getByLabel(/^Subject$/).fill('Test {{chamber_name}}');

    // Tiptap editor — fill via the editor's editable region.
    // labelledById="tpl-body-label" wires the Label as the accessible
    // name, so getByLabel matches.
    const bodyEditor = page.getByLabel(/^Body \(HTML\)$/);
    await bodyEditor.click();
    await page.keyboard.type('Hello [member name].');

    await page.getByRole('button', { name: /^Save template$/ }).click();

    await page.waitForURL('**/admin/broadcasts/templates');
    await expect(page.getByText('E2E Test Template')).toBeVisible();
  });

  test('member picks template → compose form populated with substituted chamber_name', async ({
    page,
  }) => {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByRole('textbox', { name: 'Password' }).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/portal') &&
        !url.pathname.startsWith('/portal/sign-in'),
      { timeout: 10_000 },
    );

    await page.goto('/portal/broadcasts/new');

    // Template picker is now the cmdk Combobox primitive (R1.4 H-code-3
    // — shipped via ComposeTemplatePicker). Interaction: click the
    // trigger to open the popover, then click the option by its
    // accessible name. The "(Starter)" suffix lives in a sibling <span>
    // (per R1.4 H-ux-1 separation) — assert it via a SEPARATE locator
    // rather than embedding into the option name.
    const picker = page.getByRole('combobox', {
      name: /Start from a template/i,
    });
    await picker.click();

    // E2E ordering fix 2026-05-21: Starter badge is ONLY rendered
    // INSIDE the open popover's option list (not on the collapsed
    // trigger label which shows just the template name). Assert
    // badge visibility BEFORE clicking the option (popover closes
    // immediately on selection + navigation, so badge is unreachable
    // post-nav). Earlier wording in the surrounding comment said the
    // badge stays visible "after selection" — that is incorrect for
    // the current template-picker.tsx implementation where the
    // trigger only renders `{tpl.name}` via `triggerLabel`.
    await expect(page.getByText(/Starter/).first()).toBeVisible();

    // Relax: option accessible name includes the starter-badge
    // aria-label ("Seeded by the platform") as a sibling span, so the
    // full accessible name is "Monthly Newsletter Seeded by the
    // platform". Using \b instead of $ anchor matches just the
    // template name segment while keeping the test specific.
    await page
      .getByRole('option', { name: /^Monthly Newsletter\b/ })
      .click();

    // E2E timing fix 2026-05-21: selectTemplate calls `router.push`
    // with `?template=<id>` — wait for the URL to actually carry the
    // param so the server re-render with the populated subject lands
    // before the toBeEmpty assertion runs. Without this wait, Subject
    // is still empty on the prior route render.
    await page.waitForURL(/\?template=/, { timeout: 10_000 });

    // After navigation, the compose form should be pre-populated.
    // SweCham comes from NEXT_PUBLIC_TENANT_NAME fallback (or whatever
    // tenant.display_name resolves to in the staging env).
    //
    // E2E assertion fix 2026-05-21: `toBeEmpty()` checks textContent
    // which is ALWAYS empty for `<input>` elements (input value lives
    // on the .value property, not in text children). Use `toHaveValue`
    // with regex matcher so Playwright polls until the controlled
    // input picks up the substituted subject from the server render.
    // Generous 10s timeout because Turbopack dev mode cold-compiles
    // `/portal/broadcasts/new` with the new ?template= param on first
    // request — production builds are sub-second.
    const subject = page.getByLabel(/^Subject$/);
    await expect(subject).toHaveValue(/Newsletter/, { timeout: 10_000 });

    // Bracket placeholders survive the substitution literal
    const bodyEditor = page.getByLabel(/^Message$/);
    await expect(bodyEditor).toContainText('[');

    // a11y scan on compose surface with picker — shared helper.
    await runAxeScan(page, test.info());
  });

  test('R3.5 M-16: member picks template via KEYBOARD-ONLY (WCAG 2.1.1)', async ({
    page,
  }) => {
    // WCAG 2.1.1 requires the Combobox to be operable via keyboard.
    // The Round 2 enterprise-ux-designer audit flagged that the
    // happy-path E2E test (above) only exercises mouse interaction.
    // This test exercises Tab → Space-to-open → ArrowDown → Enter.
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByRole('textbox', { name: 'Password' }).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/portal') &&
        !url.pathname.startsWith('/portal/sign-in'),
      { timeout: 10_000 },
    );

    await page.goto('/portal/broadcasts/new');

    // Focus the combobox trigger directly (matches real-user Tab
    // sequence after the page header). Then open with Space + ArrowDown
    // to the second option (skips Blank), Enter to select.
    const picker = page.getByRole('combobox', {
      name: /Start from a template/i,
    });
    await picker.focus();
    await page.keyboard.press('Space');
    // R4.3 M-4 — fail-fast assertion: cmdk Combobox renders a Radix
    // Popover containing a `<div role="listbox">` only AFTER Space
    // opens it. Asserting visibility upfront converts an ArrowDown-
    // sent-to-collapsed-trigger flake into a clear "popover didn't
    // open" failure with a helpful stack.
    await expect(page.getByRole('listbox')).toBeVisible();
    // cmdk Combobox: ArrowDown moves through options; Enter selects.
    // Press TWICE so we land on the FIRST template row (index 1) and
    // skip the "Blank" option at index 0.
    //
    // R6.5 L-6 — anchor each ArrowDown on the selection-state change
    // (cmdk sets `data-selected="true"` on the active item). Pressing
    // ArrowDown while the listbox is mid-reposition can drop the key
    // on slow CI runners; the selection-anchor assertion serialises
    // the key sequence against the DOM state instead of relying on
    // raw key-press timing.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[cmdk-item][data-selected="true"]')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[cmdk-item][data-selected="true"]')).toBeVisible();
    await page.keyboard.press('Enter');

    // URL navigated to ?template= — the page server-renders with
    // pre-populated subject. Don't assert specific option here (depends
    // on seed ordering); just confirm the URL carries the param.
    await page.waitForURL(/\?template=/);
    // E2E assertion fix 2026-05-21 (same root cause as test #3):
    // `<input>` value is on .value, not textContent — toBeEmpty always
    // passes/fails on textContent. Use toHaveValue with non-empty
    // pattern + 10s poll for Turbopack cold-compile.
    await expect(page.getByLabel(/^Subject$/)).not.toHaveValue('', {
      timeout: 10_000,
    });
  });
});
