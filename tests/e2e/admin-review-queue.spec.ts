/**
 * T099 — E2E test: admin review queue (US2 AS1–AS6 + Q14).
 *
 * Wave 6 GREEN. Spec authority: spec.md US2 AS1–AS6.
 *
 * Strategy: every test executes (no `test.fixme`). Tests that need a
 * seeded `submitted` broadcast skip at runtime when the seed is absent;
 * the killswitch state is detected by probing the response status of
 * `/admin/broadcasts` once at the start.
 *
 *   - AS1: queue surface renders (200 + filters) when F7 ON
 *           OR returns 503 feature_disabled when F7 OFF (ship-dark)
 *   - AS2: approve send-now → status flips → cron picks up
 *   - AS3: reject with reason → audit broadcast_rejected + member email enqueued
 *   - AS4: approve & schedule → scheduledFor populated
 *   - AS5: manager role sees queue read-only, no Approve/Reject buttons
 *   - AS6: concurrent admin race → second action gets 409 toast
 *   - Q14: halt-state banner + clear-halt typed-phrase confirmation
 *
 * Task 7 (2026-08-01-broadcast-review-queue-pr1) additions:
 *   - D2: Audience column never leaks the raw `segment_type` enum, and
 *         shows the localised label for the seeded row.
 *   - D3: selecting a `submitted` row's checkbox announces the running
 *         selection count via the sr-only `aria-live="polite"` region.
 *   - @a11y: axe-core WCAG 2.1/2.2 AA scans of `/admin/broadcasts` — one
 *            always-run scan of the default landing view (overdue banner
 *            + SLA banner token colours), and a second, seed-gated scan
 *            of the 1-row bulk-selected state (bulk toolbar + selection
 *            announcer) — neither of which the baseline
 *            `broadcast-axe.spec.ts` admin-queue scan exercises (it
 *            never selects a row).
 *   - @i18n: EN/TH/SV render the localised queue title + the
 *            de-jargoned SLA "review target" copy with no
 *            `MISSING_MESSAGE` / raw-key leak.
 *
 * Fix round 1 (same feature dir) — the `@a11y`/`@i18n` describes are
 * declared as SIBLINGS of the serial `admin review queue` describe below
 * (each with its own `test.describe.configure({ mode: 'default' })`),
 * not nested inside it. They must not be hostage to the destructive
 * AS2–AS6 flow: in `mode: 'serial'`, one earlier failure skips every
 * later test in the same suite, which is exactly why these read-only
 * scans never ran when they were first added nested at the end of that
 * suite. The default-view axe scan was also split out from the
 * bulk-selected-state axe scan (previously one test) so a missing seed
 * only skips the seed-dependent half, not the always-runnable core PR1
 * a11y signal.
 *
 * Task 9 (2026-08-01-broadcast-review-queue-pr2) — the `@a11y` describe now
 * sweeps the render tree Tasks 2–6 shipped: the shared `ui/table.tsx`
 * desktop `<table>` (Task 3), the `QueueCardList` mobile fallback at a
 * 360px viewport (Task 4), and the fixed-bottom `role="toolbar"` bulk bar
 * that replaced the old sticky-top `role="region"` bar (Task 5/6). The D3
 * test above's trailing assertion against that old `role="region"` bar
 * was stale after `7465ae9be` dropped it — fixed here in the same pass to
 * target the current `role="toolbar"`, since it exercises the identical
 * selector this task otherwise had to introduce anyway.
 *
 * Task 9 fix round 1 — the `@i18n` describe's per-locale test anchored its
 * PRIMARY assertion on the SLA banner's de-jargoned "Review target: within
 * 48 hours" copy. That copy is CONDITIONALLY rendered: `page.tsx` passes
 * `<SlaBanner compact={showOverdue}>`, and the compact branch (taken
 * whenever the queue currently has an overdue `submitted` broadcast) never
 * mentions "Review target" at all — it renders a bare median/p95 stat line
 * instead (a legitimate product choice: no 30-day trend is worth showing
 * when the page is already shouting "act now" via the overdue banner).
 * `compact={showOverdue}` shipped in the SAME PR1 commit (`ee0aab12d`) as
 * the original `@i18n` test, so this was a latent gap from day one — it
 * only ever passed because the dev DB happened to have zero overdue
 * broadcasts when PR1 was validated; data aging on the shared dev branch
 * eventually flipped `showOverdue` true and turned the test permanently
 * red. The fix: the per-locale test's REQUIRED assertions are now (1) the
 * queue title heading (renders unconditionally, any state), (2) no
 * `MISSING_MESSAGE`/`MISSING_KEY`, (3) no raw dotted-key leak (both the
 * full `admin.broadcasts.queue.` path AND the bare scope-relative forms
 * `queue./slaBanner./bulk./card./ageBadge.` that this page's own
 * `useTranslations(scope)` calls would render un-resolved). The SLA
 * "Review target" copy is still checked, but only OPPORTUNISTICALLY —
 * gated on the full (non-compact) banner actually being in the DOM — so
 * the test never depends on which SLA-banner render mode the live dev DB
 * happens to be in at run time.
 *
 * Task 8 (2026-08-02-broadcast-review-queue-pr3) — a new `@bulk` describe
 * (sibling of the serial suite and the `@a11y`/`@i18n` describes above, same
 * `mode: 'default'` override + same rationale: it must not be hostage to the
 * destructive AS2-AS6 flow) covers the bulk-approve confirm dialog Tasks
 * 2-7 shipped: selecting >=2 `submitted` rows opens `BulkApproveConfirmDialog`
 * (the alertdialog showing the recipient total) instead of fanning out
 * directly; the LOAD-BEARING assertion is the network-level tamper-safety
 * check -- the approve POST body is asserted, at the wire, to be exactly
 * `{decision:'send_now'}` (or `{decision:'schedule', scheduledFor}`) with no
 * recipient/total key, proving the dialog's displayed total is display-only
 * and cannot leak into the request even by accident. Also covers the 60s
 * send-now Undo (fires `POST .../cancel` with a non-empty `cancellationReason`)
 * and an axe scan of the open dialog + focus-return to `#main-content` after
 * confirm (F7-A11Y-1 -- the "Approve selected" trigger unmounts once the bulk
 * bar clears on success). Seed-gated: `seedBulkApproveFixtures` (new helper
 * in `helpers/broadcasts-seed.ts`) provisions TWO `submitted` broadcasts
 * with distinct recipient counts (`seedF7Broadcasts` only ever provisions
 * one), re-seeded fresh in a `beforeEach` since every test in this describe
 * transitions both rows out of `submitted`.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import {
  seedF7Broadcasts,
  seedBulkApproveFixtures,
  type BulkApproveSeedResult,
} from './helpers/broadcasts-seed';

/**
 * The raw `segment_type` DB enum values (`src/modules/broadcasts` domain).
 * These must never render verbatim in the Audience column — only their
 * localised label (`admin.broadcasts.review.segmentType.*`) may appear.
 */
const RAW_SEGMENT_ENUMS = [
  'event_attendees_last_90d',
  'all_members',
  'tier',
  'custom',
] as const;

const SEEDED_SUBJECT = '[E2E SEED] AS2-AS6 fixture broadcast';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

/**
 * Seed for AS2-AS6 + Q14. Provisioned by global-setup via
 * `helpers/broadcasts-seed.ts`. Falls back to .e2e-seed.json if the
 * env var didn't propagate to this worker process.
 */
function loadSeed(): {
  broadcastId?: string;
  haltedMemberDisplayName?: string;
} {
  if (process.env.E2E_SEED_BROADCAST_ID) {
    const result: { broadcastId?: string; haltedMemberDisplayName?: string } = {
      broadcastId: process.env.E2E_SEED_BROADCAST_ID,
    };
    if (process.env.E2E_SEED_HALTED_MEMBER_NAME) {
      result.haltedMemberDisplayName = process.env.E2E_SEED_HALTED_MEMBER_NAME;
    }
    return result;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
    if (!existsSync('.e2e-seed.json')) return {};
    const data = JSON.parse(readFileSync('.e2e-seed.json', 'utf8')) as {
      broadcastId: string;
      haltedMemberDisplayName: string;
    };
    return data;
  } catch {
    return {};
  }
}
const SEED = loadSeed();
const SEEDED_SUBMITTED_BROADCAST_ID = SEED.broadcastId;
const SEEDED_HALTED_MEMBER_DISPLAY_NAME = SEED.haltedMemberDisplayName;

/**
 * Review I2 — CI hard-guard against silent green builds.
 *
 * The runtime `test.skip(...)` calls below let local dev runs proceed
 * when env+seed are absent. CI MUST fail fast instead so a broken
 * F7 toggle never sneaks past as "all green (everything skipped)."
 * Set `E2E_REQUIRE_F7=true` in CI so the guard converts skip → fail.
 */
const REQUIRE_F7 = process.env.E2E_REQUIRE_F7 === 'true';
if (REQUIRE_F7) {
  const missing: string[] = [];
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) missing.push('E2E_ADMIN_*');
  if (!MANAGER_EMAIL || !MANAGER_PASSWORD) missing.push('E2E_MANAGER_*');
  if (!SEEDED_SUBMITTED_BROADCAST_ID) missing.push('E2E_SEED_BROADCAST_ID / .e2e-seed.json');
  if (process.env.FEATURE_F7_BROADCASTS !== 'true') missing.push('FEATURE_F7_BROADCASTS=true');
  if (missing.length > 0) {
    throw new Error(
      `[admin-review-queue] E2E_REQUIRE_F7=true but missing: ${missing.join(', ')}. ` +
        `Refusing to silently skip in CI. Either provide the env+seed, or unset E2E_REQUIRE_F7.`,
    );
  }
}

/**
 * Reset the seeded broadcast back to `submitted` before destructive
 * tests (AS2 approves it, AS3 rejects, AS4 schedules, AS6 races).
 * Each test runs a fresh seed so the previous run doesn't leave the
 * row in `approved` / `rejected` / `cancelled` blocking the next.
 *
 * Module-scope (not nested in the serial `describe`) — Fix round 1
 * (2026-08-01-broadcast-review-queue-pr1): the `@a11y`/`@i18n` describes
 * below need this too, and they must NOT be nested inside the serial
 * suite (see that comment), so the shared helpers are hoisted here
 * instead of duplicated.
 */
async function reseed(): Promise<void> {
  await seedF7Broadcasts();
}

async function signIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/admin/sign-in');
  // WebKit (mobile-safari) flakes when `.fill()` runs before the input
  // has reached focus-eligibility (autofill heuristics race the text).
  // Focus explicitly + verify the value committed before clicking submit.
  const emailInput = page.locator('input#email');
  const passwordInput = page.locator('input#password');
  await emailInput.click();
  await emailInput.fill(email);
  await expect(emailInput).toHaveValue(email);
  await passwordInput.click();
  await passwordInput.fill(password);
  await expect(passwordInput).toHaveValue(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    },
    { timeout: 15_000 },
  );
}

async function isFeatureEnabled(page: Page): Promise<boolean> {
  const res = await page.request.get('/admin/broadcasts');
  return res.status() !== 503;
}

test.describe.configure({ mode: 'serial' });

test.describe('admin review queue (T099 — US2 AS1–AS6 + Q14)', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  // ---------- AS1: queue surface ----------
  test('AS1: admin loads /admin/broadcasts → 200 with filters (or 503 ship-dark)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const response = await page.goto('/admin/broadcasts');
    const status = response?.status() ?? 500;

    if (status === 503) {
      // Ship-dark: killswitch off → feature_disabled JSON envelope
      const body = await response!.text();
      expect(body).toContain('feature_disabled');
      return;
    }

    // F7 ON: queue surface must render
    expect(status).toBeLessThan(400);
    await page.locator('h1').first().waitFor({ timeout: 10_000 });
    // Either: rows exist → <table> renders; OR queue empty → empty-state
    // panel with i18n title "Queue is clear" (admin.broadcasts.queue.emptyTitle)
    // OR Thai/Swedish equivalents. Match the i18n keys' English text + a
    // forgiving fallback so the assertion survives DB state drift between
    // projects (chromium / mobile-chrome / mobile-safari).
    const tableOrEmpty = page
      .getByRole('table')
      .or(page.getByText(/queue is clear|no broadcasts|no pending/i));
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 10_000 });
  });

  test('AS1: queue filters surface (status pills + member combobox + date range)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });
    // Filter bar uses `role="search"` landmark per WAI-ARIA Authoring
    // Practices (D1 / A3 UX hardening).
    await expect(page.getByRole('search').first()).toBeVisible();
    // Member filter is a shadcn Select (combobox), no longer a native
    // <select> (D2). Trigger has role="combobox".
    await expect(
      page.getByRole('combobox', { name: /member/i }).first(),
    ).toBeVisible();
    // Date range inputs still present (controlled).
    await expect(page.locator('input[name="fromDate"]').first()).toBeVisible();
    await expect(page.locator('input[name="toDate"]').first()).toBeVisible();
  });

  test('D1: filter checkboxes round-trip through URL (uncheck submitted → URL writes status_all sentinel)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Default visit: "submitted" checkbox is checked, URL has no status
    // params (server defaults to `['submitted']`).
    const submittedCheckbox = page.locator('input[name="status"][value="submitted"]');
    await expect(submittedCheckbox).toBeChecked();

    // Click submitted → React controlled-checkbox state update is
    // deferred via `useTransition` + `router.replace`. Playwright's
    // strict `.uncheck()` would assert the DOM `checked` attribute
    // flipped synchronously — but with React 19 transitions the input
    // stays `checked` until the router transition commits. Plain
    // `.click()` performs the same user action without that
    // post-condition, then we wait for the URL change as the
    // authoritative signal that the state update committed.
    await submittedCheckbox.click();
    await page.waitForURL(/status_all=1/, { timeout: 5_000 });

    // After URL settles, ALL chips appear UNCHECKED (sentinel = "show
    // every status" surfaces visually as a fully-empty chip strip so
    // the user has an honest read of "no chip selected → seeing
    // everything"). See `queue-filters.tsx` visualStatus split.
    await expect(
      page.locator('input[name="status"][value="submitted"]'),
    ).not.toBeChecked();
    await expect(
      page.locator('input[name="status"][value="approved"]'),
    ).not.toBeChecked();

    // Click "Reset filters" → URL goes back to pristine (no params), and
    // we're back to the default `['submitted']` view.
    await page
      .getByRole('button', { name: /reset filters|รีเซ็ต|återställ filter/i })
      .first()
      .click();
    await page.waitForURL((u) => !new URL(u).search.includes('status'), {
      timeout: 5_000,
    });
    // Confirm submitted re-ticks as the default view.
    await expect(
      page.locator('input[name="status"][value="submitted"]'),
    ).toBeChecked();
  });

  // ---------- D2: Audience column raw-enum leak ----------
  test('D2: Audience column never renders the raw segment_type enum', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Negative invariant — holds regardless of what's seeded. Scope to
    // the table body: the raw strings are short/generic ("tier",
    // "custom") enough that a page-wide search risks a false positive
    // from unrelated furniture, so only the Audience cell's exact
    // (whitespace-normalised) text content is checked, never a
    // substring of surrounding copy.
    const tbody = page.locator('tbody');
    for (const raw of RAW_SEGMENT_ENUMS) {
      await expect(tbody.getByText(new RegExp(`^${raw}$`))).toHaveCount(0);
    }
  });

  test('D2b: Audience column shows the localised label for the seeded all_members broadcast', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for the seeded all_members broadcast',
    );
    await reseed();

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // The AS2-AS6 seed row is `segment_type = 'all_members'`
    // (`helpers/broadcasts-seed.ts`) → the Audience cell must render the
    // localised label "All members" (admin.broadcasts.review.segmentType.
    // all_members), never the raw enum string.
    const seededRow = page
      .locator('tbody tr')
      .filter({ hasText: SEEDED_SUBJECT });
    await expect(seededRow).toBeVisible();
    await expect(seededRow.getByText('All members', { exact: true })).toBeVisible();
    await expect(seededRow.getByText('all_members')).toHaveCount(0);
  });

  // ---------- D3: bulk selection aria-live ----------
  test('D3: selecting a submitted row checkbox announces the count via aria-live', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for a submitted row to select',
    );
    await reseed();

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Permanently-mounted sr-only announcer (Round-2 review Fix 1 in
    // `queue-table-client.tsx`) — empty before any selection so the
    // 0→1 transition is a text MUTATION on an already-mounted node,
    // which is what NVDA/JAWS actually announce.
    const liveRegion = page.locator(
      '[role="status"][aria-live="polite"].sr-only',
    );
    await expect(liveRegion).toBeAttached();

    const seededRow = page
      .locator('tbody tr')
      .filter({ hasText: SEEDED_SUBJECT });
    await seededRow.getByRole('checkbox').click();

    await expect(liveRegion).toContainText(/1 selected/);
    // The visible fixed-bottom bulk toolbar mounts alongside it — Task 5/6
    // (2026-08-01-broadcast-review-queue-pr2) replaced the old sticky-top
    // `role="region"` bar this assertion originally checked with a
    // fixed-bottom `role="toolbar"` (`7465ae9be`); its own `aria-live`
    // span carries the same "N selected" text.
    const toolbar = page.getByRole('toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator('[aria-live="polite"]')).toContainText(
      /1 selected/,
    );
  });

  // ---------- AS2: approve send-now ----------
  test('AS2: admin approves "send now" → status flips to approved', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    await page.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await page.getByRole('button', { name: /^approve$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole('button', { name: /^approve$/i }).click();
    // Wait for dialog to dismiss → indicates use-case completed (or 409
    // returned a toast but kept dialog open). Toast-success closes the
    // dialog; navigate refresh re-renders the StatusBadge.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    // Status badge in detail page should now read Approved or Sending
    // (cron may have already kicked off send-now within polling window).
    await expect(
      page.getByText(/^(Approved|Sending|Sent)$/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ---------- AS3: reject with reason ----------
  test('AS3: admin rejects with reason → status=rejected', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    await page.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await page.getByRole('button', { name: /^reject$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog
      .getByRole('textbox')
      .fill('Off-topic for chamber audience');
    await dialog.getByRole('button', { name: /^reject$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      page.getByText(/^Rejected$/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ---------- AS4: approve & schedule ----------
  test('AS4: admin approves with scheduled future timestamp', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    await page.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await page.getByRole('button', { name: /^approve$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog
      .getByRole('radio', { name: /schedule/i })
      .check({ force: true });
    // datetime-local input expects LOCAL time without timezone suffix.
    // Build a local-time string ~70 min in the future so the
    // server-side `min: now+5min` zod refine passes even with browser
    // ↔ server clock skew.
    const future = new Date(Date.now() + 70 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const localStr = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
    await dialog.locator('input[type="datetime-local"]').fill(localStr);
    await dialog.getByRole('button', { name: /^approve$/i }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(
      page.getByText(/^Approved$/i).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  // ---------- AS5: manager read-only ----------
  test('AS5: manager sees ManagerReadonlyBanner + NO Approve/Reject buttons', async ({
    page,
  }) => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL and E2E_MANAGER_PASSWORD',
    );
    await signIn(page, MANAGER_EMAIL!, MANAGER_PASSWORD!);
    const response = await page.goto('/admin/broadcasts');
    const status = response?.status() ?? 500;

    if (status === 503) {
      // Manager 503 path acceptable when killswitch off
      return;
    }

    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    const banner = page.getByRole('region').filter({
      hasText: /read.only|view.only|manager/i,
    });
    await expect(banner.first()).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByRole('button', { name: /^approve(\s|$)/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^reject(\s|$)/i }),
    ).toHaveCount(0);
  });

  // ---------- AS6: concurrent admin race ----------
  test('AS6: concurrent approve → second admin gets 409 broadcast_concurrent_action_blocked', async ({
    browser,
  }) => {
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID for an existing `submitted` broadcast',
    );
    await reseed();

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    const enabled = await isFeatureEnabled(pageA);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await signIn(pageA, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await signIn(pageB, ADMIN_EMAIL!, ADMIN_PASSWORD!);

    // Both tabs hit the same broadcast detail
    await pageA.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);
    await pageB.goto(`/admin/broadcasts/${SEEDED_SUBMITTED_BROADCAST_ID}`);

    // Tab A approves first via in-page fetch (carries Origin so CSRF
    // Origin allow-list passes; `pageA.request.post` skips Origin and
    // hits the proxy 403).
    const responseA = await pageA.evaluate(async (id: string) => {
      const r = await fetch(`/api/admin/broadcasts/${id}/approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'send_now' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, SEEDED_SUBMITTED_BROADCAST_ID as string);
    expect(responseA.status).toBeLessThan(400);

    const responseB = await pageB.evaluate(async (id: string) => {
      const r = await fetch(`/api/admin/broadcasts/${id}/approve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'send_now' }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, SEEDED_SUBMITTED_BROADCAST_ID as string);
    expect([409, 422]).toContain(responseB.status);
    expect(responseB.body?.error?.code).toMatch(
      /broadcast_concurrent_action_blocked|broadcast_invalid_state_transition/,
    );

    await ctxA.close();
    await ctxB.close();
  });

  // ---------- Q14: halt-state banner ----------
  test('Q14: halt-state banner shows when ≥1 member has broadcasts_halted_until_admin_review=true', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_HALTED_MEMBER_DISPLAY_NAME,
      'Set E2E_SEED_HALTED_MEMBER_NAME for a seeded halted member',
    );

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Halt-state banner visible
    const banner = page.getByRole('region').filter({
      hasText: /halted|pending review/i,
    });
    await expect(banner.first()).toBeVisible();

    // Halted member name surfaced
    await expect(
      page.getByText(SEEDED_HALTED_MEMBER_DISPLAY_NAME!).first(),
    ).toBeVisible();

    // Clear-halt button present (typed-phrase confirmation dialog)
    await expect(
      page.getByRole('button', { name: /clear|resume/i }).first(),
    ).toBeVisible();
  });
});

/**
 * ---------- @a11y: overdue banner + SLA tokens + bulk selection ----------
 *
 * Fix round 1 (2026-08-01-broadcast-review-queue-pr1) — this describe is a
 * SIBLING of the serial `admin review queue` suite above, not a child of
 * it. It was originally nested inside that suite's
 * `test.describe.configure({ mode: 'serial' })`, positioned AFTER the
 * destructive AS2–AS6 tests — in serial mode, one earlier failure starves
 * every later test in the same suite, which is exactly why these read-only
 * scans never ran in the first review round (AS2's flaky navigation
 * cascaded, then a degraded dev server compounded it). Read-only a11y/i18n
 * scans must not be hostage to the destructive approve/reject/schedule
 * flow, so they sign in independently here and carry no dependency on any
 * state AS2–AS6 leave behind.
 *
 * Being a sibling in the same FILE is not enough on its own: the
 * `test.describe.configure({ mode: 'serial' })` call above (scoped to the
 * file's root suite, since it's called outside any describe) cascades
 * into every top-level describe declared afterwards in this file unless
 * overridden — see the Playwright docs' own "run multiple describes in
 * parallel" example, which nests `configure({ mode: 'default' })` inside
 * each sibling describe for exactly this reason. Without the override
 * below, this suite would silently inherit 'serial' from the admin
 * review queue suite and remain hostage to it despite living outside its
 * braces.
 */
test.describe('@a11y queue render-tree scan — desktop table / mobile card / bulk toolbar', () => {
  test.describe.configure({ mode: 'default' });
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  // Minor #1 fix (Fix round 1) — split into two tests. The default-view
  // scan is seed-independent and covers the CORE PR1 a11y goal (overdue
  // banner + SLA banner token colours); it must always run and report its
  // own pass/fail rather than being swallowed by a `test.skip` on the
  // (seed-gated) bulk-selected scan that used to share its test body.
  test('axe-core WCAG 2.1/2.2 AA scan — default view (desktop table, overdue banner + SLA tokens)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Task 9 — the Playwright `chromium` project's default viewport
    // (1280×720, Desktop Chrome) is ≥ the `md` breakpoint, so the shared
    // `ui/table.tsx` primitive Task 3 adopted (`hidden md:block` wrapper)
    // must render, not a hand-rolled table.
    await expect(page.locator('[data-slot="table"]')).toBeVisible();

    // Covers the overdue banner (role="alert", when count>0), the
    // always-present SLA banner's severity-coloured token pill, filters,
    // and the table/empty-state.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // Task 9 — proves the `hidden md:block` (desktop table) / `md:hidden`
  // (`QueueCardList`, Task 4) split actually holds under a real browser's
  // CSS engine at a phone-width viewport (not just a unit-test snapshot),
  // then axe-scans the mobile card render — its checkbox, status badge,
  // and `ReviewActions` button group are never painted into the a11y tree
  // by the desktop-viewport scan above.
  test('axe-core WCAG 2.1/2.2 AA scan — mobile QueueCardList at 360px (desktop table hidden)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    await expect(
      page.locator('[data-testid="queue-card-list"]'),
    ).toBeVisible();
    // Attached-then-hidden (not just "not matched") — the desktop table
    // must still be a CSS-hidden DOM node at this width (`hidden`), never
    // removed from the tree entirely, which would be a different
    // regression `toBeHidden()` alone can't distinguish from.
    const desktopTable = page.locator('[data-slot="table"]');
    await expect(desktopTable).toBeAttached();
    await expect(desktopTable).toBeHidden();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('axe-core WCAG 2.1/2.2 AA scan — fixed-bottom bulk toolbar, 1 row selected (plain tab order)', async ({
    page,
  }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
    const enabled = await isFeatureEnabled(page);
    test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');
    test.skip(
      !SEEDED_SUBMITTED_BROADCAST_ID,
      'Set E2E_SEED_BROADCAST_ID to cover the bulk-selection a11y state',
    );
    await reseed();

    await page.goto('/admin/broadcasts');
    await page.locator('h1').first().waitFor({ timeout: 10_000 });

    // Selecting a submitted row mounts the fixed-bottom `role="toolbar"`
    // bulk bar (Task 5/6 — replaces the deleted sticky-top `role="region"`
    // bar) + activates the sr-only aria-live selection announcer, neither
    // of which the default-view scan above (0 rows selected) ever renders
    // into the accessibility tree.
    const seededRow = page
      .locator('tbody tr')
      .filter({ hasText: SEEDED_SUBJECT });
    await seededRow.getByRole('checkbox').click();

    const toolbar = page.getByRole('toolbar');
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator('[aria-live="polite"]')).toContainText(
      /1 selected/,
    );

    // Task 9 — `queue-bulk-action-bar.tsx`'s module docstring claims
    // "Plain tab order — no roving-tabindex, matching both precedents
    // exactly." Prove it behaviourally: focus Clear directly, then a
    // single Tab must land on Approve. Had the toolbar instead implemented
    // the WAI-ARIA APG toolbar widget pattern's roving tabindex (the
    // ARIA-spec default for `role="toolbar"`), Tab from Clear would leave
    // the toolbar entirely rather than reaching Approve — this deliberate
    // divergence from the spec pattern is exactly what this assertion
    // guards against regressing.
    const clearButton = toolbar.getByRole('button', { name: /clear/i });
    const approveButton = toolbar.getByRole('button', {
      name: /approve selected/i,
    });
    await clearButton.focus();
    await expect(clearButton).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(approveButton).toBeFocused();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});

// ---------- @i18n: stable title + no key leaks (+ opportunistic SLA copy) ----------
// Fix round 1 — sibling of the serial suite, same rationale as @a11y above
// (including the `mode: 'default'` override — a file-level `configure`
// cascades into every later top-level describe unless reset).
//
// Task 9 fix round 1 — see the module docstring's "Task 9 fix round 1"
// entry for the full root-cause writeup. Summary: this describe used to
// assert the SLA banner's "Review target: within 48 hours" copy
// unconditionally, but that copy is CONDITIONALLY rendered
// (`SlaBanner compact={showOverdue}` demotes to a bare stat line — no
// "Review target" mention at all — whenever the queue currently has an
// overdue broadcast, a legitimate product state, not a bug). The REQUIRED
// per-locale assertions are now state-independent: a stable heading, no
// `MISSING_MESSAGE`, no raw dotted-key leak. The SLA copy is still checked
// when it happens to be in the DOM, but never required.
test.describe('@i18n queue localisation — stable title, no key leaks', () => {
  test.describe.configure({ mode: 'default' });
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  // STABLE anchor — the queue page title renders on every load regardless
  // of overdue/SLA-compact runtime state. Values copied verbatim from
  // `src/i18n/messages/{en,th,sv}.json` → `admin.broadcasts.queue.title`.
  const TITLE_RE: Record<'en' | 'th' | 'sv', RegExp> = {
    en: /E-Blast review queue/,
    th: /คิวตรวจสอบ E-Blast/,
    sv: /Granskningskö för E-Blast/,
  };
  // OPPORTUNISTIC only (see module docstring) — the de-jargoned "review
  // target" line (`admin.broadcasts.queue.slaBanner.targetSla`), present
  // only when the full (non-compact) SlaBanner renders.
  const SLA_TARGET_RE: Record<'en' | 'th' | 'sv', RegExp> = {
    en: /Review target: within 48 hours/,
    th: /เป้าหมายการตรวจ: ภายใน 48 ชั่วโมง/,
    sv: /Granskningsmål: inom 48 timmar/,
  };

  for (const locale of ['en', 'th', 'sv'] as const) {
    test(`renders in ${locale.toUpperCase()} — stable title, no raw key leak, no MISSING_MESSAGE`, async ({
      page,
      context,
    }) => {
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      const enabled = await isFeatureEnabled(page);
      test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

      // Port-agnostic per RFC 6265 (domain+path only, no explicit
      // url/port) — matches `broadcast-i18n.spec.ts` T197's
      // NEXT_LOCALE cookie convention so this test works unchanged
      // whether Playwright's baseURL is :3100 or a worktree's :3101.
      await context.addCookies([
        { name: 'NEXT_LOCALE', value: locale, domain: 'localhost', path: '/' },
      ]);
      await page.goto('/admin/broadcasts');
      await page.locator('h1').first().waitFor({ timeout: 10_000 });

      // REQUIRED #1 — stable localised heading, any runtime state.
      await expect(
        page.getByRole('heading', { name: TITLE_RE[locale], level: 1 }),
      ).toBeVisible();

      const bodyText: string = await page.evaluate(
        () => document.body.innerText,
      );
      // REQUIRED #2 — no MISSING_MESSAGE / MISSING_KEY anywhere on the page.
      expect(bodyText).not.toMatch(/MISSING_MESSAGE|MISSING_KEY/);
      // REQUIRED #3 — no raw i18n dotted-key leak. next-intl does not throw
      // on a missing key; it renders the dotted path instead (this repo's
      // "next-intl no throw on missing key" gotcha). The first pattern
      // covers the full absolute path under this page's namespace; the
      // second covers the bare scope-relative form each component's own
      // `useTranslations(scope)` call would render un-resolved
      // (`sla-banner.tsx` → `slaBanner.*`, `queue-bulk-action-bar.tsx` →
      // `bulk.*`, `queue-card-list.tsx` → `card.*`, the age-badge helper →
      // `ageBadge.*`).
      expect(bodyText).not.toMatch(/admin\.broadcasts\.queue\.[a-zA-Z]/);
      expect(bodyText).not.toMatch(
        /\b(queue|slaBanner|bulk|card|ageBadge)\.[a-zA-Z]+/,
      );

      // OPPORTUNISTIC — only when the full (non-compact) SlaBanner happens
      // to be in the DOM (i.e. the queue has no currently-overdue
      // broadcast) does this locale's de-jargoned "Review target" copy
      // apply. When the compact stat-line branch is showing instead
      // (`SlaBanner compact={showOverdue}`), there's nothing to check here
      // — that state renders no "Review target" text at all, by design.
      const slaTargetLocator = page.getByText(SLA_TARGET_RE[locale]);
      if ((await slaTargetLocator.count()) > 0) {
        await expect(slaTargetLocator).toBeVisible();
      }
    });
  }
});

// ---------- @bulk: bulk-approve confirm dialog — schedule / Undo / tamper-safety ----------
// Task 8 (2026-08-02-broadcast-review-queue-pr3) — sibling of the serial suite
// and the `@a11y`/`@i18n` describes above, same `mode: 'default'` override +
// same rationale (must not be hostage to the destructive AS2-AS6 flow, and a
// file-level `configure({mode:'serial'})` cascades into every later top-level
// describe unless reset here).
test.describe(
  '@bulk bulk-approve confirm dialog — schedule + Undo + tamper-safety (Task 8, 2026-08-02-broadcast-review-queue-pr3)',
  () => {
    test.describe.configure({ mode: 'default' });
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
    );

    let bulkSeed: BulkApproveSeedResult | null = null;

    // Every test in this describe transitions both fixture rows out of
    // `submitted` (approve send-now, approve+schedule, or reject via the
    // confirm gate) — re-seed fresh before each one, mirroring how the
    // serial suite's destructive AS2-AS6 tests each call `reseed()` at
    // their own start.
    test.beforeEach(async () => {
      bulkSeed = await seedBulkApproveFixtures();
    });

    /** Signs in, opens the queue, and checks both seeded fixture rows. */
    async function openQueueAndSelectBoth(page: Page): Promise<void> {
      await page.goto('/admin/broadcasts');
      await page.locator('h1').first().waitFor({ timeout: 10_000 });
      for (const subject of bulkSeed!.subjects) {
        const row = page.locator('tbody tr').filter({ hasText: subject });
        await row.getByRole('checkbox').click();
      }
      const toolbar = page.getByRole('toolbar');
      await expect(toolbar).toBeVisible();
      await expect(toolbar.locator('[aria-live="polite"]')).toContainText(
        /2 selected/,
      );
    }

    test('confirm gate: selecting >=2 submitted rows opens the alertdialog showing the recipient total, and no approve request fires before confirm', async ({
      page,
    }) => {
      test.skip(
        !bulkSeed,
        'needs >=2 submitted broadcasts (requires DATABASE_URL + E2E_MEMBER_EMAIL to seed)',
      );
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      const enabled = await isFeatureEnabled(page);
      test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

      // Registered BEFORE the "Approve selected" click — opening the dialog
      // alone must never fan out; only `handleConfirm` inside it may.
      const approveRequestUrls: string[] = [];
      page.on('request', (req) => {
        if (req.method() === 'POST' && /\/approve$/.test(req.url())) {
          approveRequestUrls.push(req.url());
        }
      });

      await openQueueAndSelectBoth(page);
      await page
        .getByRole('toolbar')
        .getByRole('button', { name: /approve selected/i })
        .click();

      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      // `admin.broadcasts.queue.bulk.confirm.recipientTotal` — "Reaches ~7
      // recipients across 2 broadcasts." (3 + 4 from the two fixtures).
      await expect(dialog).toContainText(
        new RegExp(String(bulkSeed!.totalRecipients)),
      );
      await expect(dialog).toContainText(/2/);

      expect(approveRequestUrls).toHaveLength(0);
    });

    test('tamper-safety (network): send-now confirm POSTs exactly {decision:"send_now"} per broadcast — no recipient/total key ever reaches the wire', async ({
      page,
    }) => {
      test.skip(
        !bulkSeed,
        'needs >=2 submitted broadcasts (requires DATABASE_URL + E2E_MEMBER_EMAIL to seed)',
      );
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      const enabled = await isFeatureEnabled(page);
      test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

      await openQueueAndSelectBoth(page);
      await page
        .getByRole('toolbar')
        .getByRole('button', { name: /approve selected/i })
        .click();

      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Registered BEFORE the confirm click, keyed to each fixture's own id
      // — this is the e2e mirror of the unit-level tamper test.
      // `BulkApproveDecision` structurally cannot carry a recipient count,
      // so this must hold for every id in the fan-out, not just one.
      const requestsPromise = Promise.all(
        bulkSeed!.broadcastIds.map((id) =>
          page.waitForRequest(
            (req) =>
              req.method() === 'POST' &&
              req.url().includes(`/api/admin/broadcasts/${id}/approve`),
            { timeout: 15_000 },
          ),
        ),
      );

      await dialog
        .getByRole('button', { name: /approve & send now/i })
        .click();

      const requests = await requestsPromise;
      for (const req of requests) {
        expect(req.postDataJSON()).toEqual({ decision: 'send_now' });
      }
    });

    test('schedule: picking Schedule + a valid Bangkok time confirms with POST {decision:"schedule", scheduledFor:<ISO ending in Z>}', async ({
      page,
    }) => {
      test.skip(
        !bulkSeed,
        'needs >=2 submitted broadcasts (requires DATABASE_URL + E2E_MEMBER_EMAIL to seed)',
      );
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      const enabled = await isFeatureEnabled(page);
      test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

      await openQueueAndSelectBoth(page);
      await page
        .getByRole('toolbar')
        .getByRole('button', { name: /approve selected/i })
        .click();

      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await dialog
        .getByRole('radio', { name: /schedule/i })
        .check({ force: true });

      // Same construction as AS4 — local wall-time ~70 min ahead so the
      // server-side `min: now+5min` re-validation passes even under
      // browser<->server clock skew.
      const future = new Date(Date.now() + 70 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const localStr = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T${pad(future.getHours())}:${pad(future.getMinutes())}`;
      await dialog.locator('input[type="datetime-local"]').fill(localStr);

      const requestsPromise = Promise.all(
        bulkSeed!.broadcastIds.map((id) =>
          page.waitForRequest(
            (req) =>
              req.method() === 'POST' &&
              req.url().includes(`/api/admin/broadcasts/${id}/approve`),
            { timeout: 15_000 },
          ),
        ),
      );

      await dialog
        .getByRole('button', { name: /approve & schedule/i })
        .click();

      const requests = await requestsPromise;
      for (const req of requests) {
        const body = req.postDataJSON() as {
          decision: string;
          scheduledFor: string;
        };
        expect(body).toEqual({
          decision: 'schedule',
          scheduledFor: expect.stringMatching(/Z$/),
        });
        expect(Date.parse(body.scheduledFor)).toBeGreaterThan(Date.now());
      }
    });

    test('Undo: after a send-now confirm, the toast Undo action fires POST .../cancel with a non-empty cancellationReason', async ({
      page,
    }) => {
      test.skip(
        !bulkSeed,
        'needs >=2 submitted broadcasts (requires DATABASE_URL + E2E_MEMBER_EMAIL to seed)',
      );
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      const enabled = await isFeatureEnabled(page);
      test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

      await openQueueAndSelectBoth(page);
      await page
        .getByRole('toolbar')
        .getByRole('button', { name: /approve selected/i })
        .click();

      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      await dialog
        .getByRole('button', { name: /approve & send now/i })
        .click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });

      // 60s send-now Undo toast (`admin.broadcasts.queue.bulk.undo.action`
      // = "Undo") — appears once the fan-out resolves with >=1 success.
      const undoButton = page.getByRole('button', { name: /^undo$/i });
      await expect(undoButton).toBeVisible({ timeout: 15_000 });

      const cancelRequestsPromise = Promise.all(
        bulkSeed!.broadcastIds.map((id) =>
          page.waitForRequest(
            (req) =>
              req.method() === 'POST' &&
              req.url().includes(`/api/admin/broadcasts/${id}/cancel`),
            { timeout: 15_000 },
          ),
        ),
      );

      await undoButton.click();

      const requests = await cancelRequestsPromise;
      for (const req of requests) {
        const body = req.postDataJSON() as { cancellationReason: string };
        expect(typeof body.cancellationReason).toBe('string');
        expect(body.cancellationReason.length).toBeGreaterThan(0);
      }
    });

    test('@a11y: axe scan of the open bulk-approve confirm dialog -> 0 violations; focus returns to #main-content after confirm', async ({
      page,
    }) => {
      test.skip(
        !bulkSeed,
        'needs >=2 submitted broadcasts (requires DATABASE_URL + E2E_MEMBER_EMAIL to seed)',
      );
      await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!);
      const enabled = await isFeatureEnabled(page);
      test.skip(!enabled, 'F7 feature flag is OFF (ship-dark)');

      await openQueueAndSelectBoth(page);
      await page
        .getByRole('toolbar')
        .getByRole('button', { name: /approve selected/i })
        .click();

      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(results.violations).toEqual([]);

      // F7-A11Y-1 — the "Approve selected" trigger unmounts once the bulk
      // bar clears on a successful approve (`closedViaSuccessRef`), so
      // focus must land on the `#main-content` landmark, never drop to
      // `<body>`. `expect.poll` rather than a fixed wait — Base UI resolves
      // `finalFocus` asynchronously relative to the dialog's own unmount.
      await dialog
        .getByRole('button', { name: /approve & send now/i })
        .click();
      await expect(dialog).toBeHidden({ timeout: 15_000 });

      await expect
        .poll(
          async () => page.evaluate(() => document.activeElement?.id ?? null),
          { timeout: 5_000 },
        )
        .toBe('main-content');
    });
  },
);
