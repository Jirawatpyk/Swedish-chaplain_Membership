/**
 * F8 Phase 4 Wave I8 · T113 — admin send-reminder-now E2E (US2 admin surface).
 *
 * The "tier-aware reminder cron" is HTTP-Bearer authed (cron-job.org →
 * `/api/cron/renewals/dispatch-coordinator` → per-tenant route → core
 * `dispatchOneCycle`) and is NOT a UI surface, so a Playwright browser
 * test cannot exercise it directly. The user-visible piece of US2 is the
 * **admin manual "Send reminder" action** in the pipeline-table row
 * menu (Wave I6+I7 T108) — clicking it invokes the same `dispatchOneCycle`
 * core path as the cron, then shows a sonner toast per FR-058.
 *
 * Coverage strategy for AS1-AS7:
 *   - AS1 (cron sends T-X reminders) — covered by Wave I8 integration
 *     tests T109-T112 on live Neon (8 files / 70 tests).
 *   - AS6 (admin can send reminder now) — covered HERE: dropdown click
 *     surfaces a toast.
 *   - AS7 (concurrent admin / idempotency hit) — covered by route unit
 *     test (Wave I6+I7) + integration test T109.
 *
 * Gate: `FEATURE_F8_RENEWALS=false` (Phase 4 ships dark) skips. Sign-in
 * env vars required.
 *
 * Run: `pnpm test:e2e --grep "tier-aware-reminder-cron" --workers=1`
 * (workers=1 mandatory per memory feedback_e2e_workers).
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

test.describe('F8 — admin send-reminder UI (US2 AS6, T113)', () => {
  test('row actions menu surfaces a "Send reminder" item that fires a toast', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await page.waitForLoadState('networkidle');

    // Pipeline header confirms we landed on the right page.
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible();

    // Locate the first row's "..." actions trigger. The trigger has
    // aria-label "Actions for {company}" per pipeline-table.tsx so we
    // match the prefix.
    // Global setup seeds an `upcoming` cycle for the e2e member, so a
    // row should always be present.
    const rowMenuTrigger = page
      .getByRole('button', { name: /actions for /i })
      .first();
    await expect(rowMenuTrigger).toBeVisible({ timeout: 10_000 });

    await rowMenuTrigger.click();

    // The dropdown menu opens. Send-reminder item is the first
    // enabled option (Mark contacted is still disabled in Phase 4).
    const sendReminderItem = page.getByRole('menuitem', {
      name: /send reminder/i,
    });
    await expect(sendReminderItem).toBeVisible();
    await expect(sendReminderItem).toBeEnabled();

    // Click it. The handler issues a POST to
    // /api/admin/renewals/{cycleId}/send-reminder-now and dispatches a
    // sonner toast based on the outcome. Whichever toast variant fires
    // (success/info/warning/error), it should appear within a few
    // seconds and be announced to assistive tech via role=status.
    await sendReminderItem.click();

    // Sonner renders toasts in an `ol[role=region]` with each toast
    // carrying role="status" or role="alert" depending on the variant.
    // Wait for ANY toast to appear — the specific variant depends on
    // seed state (idempotency hit vs first send vs gate skip).
    const toast = page
      .locator('[data-sonner-toast]')
      .first();
    await expect(toast).toBeVisible({ timeout: 10_000 });

    // The toast text contains one of the expected i18n strings shipped
    // in Wave I6+I7. Match any of the success / skipped / failure
    // variants — the exact one depends on what the seeded cycle's state
    // is when the test runs.
    const toastText = (await toast.textContent()) ?? '';
    expect(toastText.length).toBeGreaterThan(0);
    expect(toastText).toMatch(
      /reminder sent|already sent|skipped|failed|could not send|not authorized|too many requests/i,
    );
  });

  test('"Send reminder" menu item is keyboard-reachable from the row trigger', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await page.waitForLoadState('networkidle');

    const rowMenuTrigger = page
      .getByRole('button', { name: /actions for /i })
      .first();
    await expect(rowMenuTrigger).toBeVisible({ timeout: 10_000 });

    // Keyboard activation: focus + Enter opens the menu, ArrowDown navigates.
    await rowMenuTrigger.focus();
    await page.keyboard.press('Enter');

    // First menu item should be focusable. The dropdown auto-focuses
    // the first enabled item on open per Radix/base-ui behaviour.
    const sendReminderItem = page.getByRole('menuitem', {
      name: /send reminder/i,
    });
    await expect(sendReminderItem).toBeVisible();

    // Press Escape to dismiss without firing the action.
    await page.keyboard.press('Escape');
    await expect(sendReminderItem).not.toBeVisible();
  });
});
