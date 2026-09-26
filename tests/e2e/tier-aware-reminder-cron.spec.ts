/**
 * F8 Phase 4 Wave I8 · T113 — admin send-reminder-now E2E (US2 admin surface).
 *
 * The "tier-aware reminder cron" is HTTP-Bearer authed (cron-job.org →
 * `/api/cron/renewals/dispatch-coordinator` → per-tenant route → core
 * `dispatchOneCycle`) and is NOT a UI surface, so a Playwright browser
 * test cannot exercise it directly. The user-visible piece of US2 is the
 * **admin manual "Send reminder" action** on the pipeline row (Wave I6+I7
 * T108; a visible row button since #279, no longer a ⋯ menu item) —
 * clicking it invokes the same `dispatchOneCycle` core path as the cron,
 * then shows a sonner toast per FR-058.
 *
 * Coverage strategy for AS1-AS7:
 *   - AS1 (cron sends T-X reminders) — covered by Wave I8 integration
 *     tests T109-T112 on live Neon (8 files / 70 tests).
 *   - AS6 (admin can send reminder now) — covered HERE: the row button
 *     surfaces a toast, and is reachable by keyboard.
 *   - AS7 (concurrent admin / idempotency hit) — covered by route unit
 *     test (Wave I6+I7) + integration test T109.
 *
 * Gate: `FEATURE_F8_RENEWALS=false` (Phase 4 ships dark) skips. Sign-in
 * env vars required.
 *
 * Run: `pnpm test:e2e --grep "tier-aware-reminder-cron" --workers=1`
 * (workers=1 mandatory per memory feedback_e2e_workers).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { seedOneAtRiskMember, type SeededAtRiskMember } from './helpers/seed-at-risk-member';

/**
 * The first pipeline row's ⋯ trigger ("Actions for {company}", per
 * row-actions.tsx) and that SAME row's "Send reminder to {company}" button.
 * Keyed on the company so both locators address one row — `.first()` on
 * each separately could pair two different rows. Global setup seeds an
 * `upcoming` cycle for the e2e member, so a row is always present.
 */
async function firstRowReminderControls(page: Page) {
  const rowMenuTrigger = page.getByRole('button', { name: /^actions for /i }).first();
  await expect(rowMenuTrigger).toBeVisible({ timeout: 10_000 });
  const company = ((await rowMenuTrigger.getAttribute('aria-label')) ?? '').replace(
    /^actions for /i,
    '',
  );
  const sendReminderButton = page.getByRole('button', {
    name: `Send reminder to ${company}`,
    exact: true,
  });
  return { rowMenuTrigger, sendReminderButton };
}

test.describe('F8 — admin send-reminder UI (US2 AS6, T113)', () => {
  // The toast test sends to a member of its own. The shared e2e member ("E2E
  // Alpha Co") also carries the invoice fixture's PAID 2026 membership bills,
  // none linked to the upcoming cycle the renewals seed gives it, so Gate 7.5
  // (unreconciled paid membership invoice) skips the send — correctly — and the
  // toast reads "Skipped — unreconciled_paid_membership_invoice". A member with
  // no billing history keeps this test about the button, and a fresh one per
  // run keeps the first-send outcome deterministic. Its cycle expires in 30
  // days, so it lands in the pipeline's default T-30 view.
  let seeded: SeededAtRiskMember | undefined;
  test.beforeAll(async () => {
    seeded = await seedOneAtRiskMember('regular', 2026);
  });
  test.afterAll(async () => {
    await seeded?.cleanup();
  });

  test('the row "Send reminder" button fires a toast', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await page.waitForLoadState('networkidle');

    // Pipeline header confirms we landed on the right page.
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible();

    if (!seeded) throw new Error('beforeAll did not seed the reminder target member');
    const sendReminderButton = page.getByRole('button', {
      name: `Send reminder to ${seeded.companyName}`,
      exact: true,
    });
    await expect(sendReminderButton).toBeVisible({ timeout: 10_000 });
    await expect(sendReminderButton).toBeEnabled();

    // Click it. The handler issues a POST to
    // /api/admin/renewals/{cycleId}/send-reminder-now and dispatches a
    // sonner toast based on the outcome. Whichever toast variant fires
    // (success/info/warning/error), it should appear within a few
    // seconds and be announced to assistive tech via role=status.
    await sendReminderButton.click();

    // AURA renders toasts in a `.aura-toaster` region (spec 122), each toast
    // carrying role="status", or role="alert" for the danger tone.
    // Wait for ANY toast to appear — the specific variant depends on
    // seed state (idempotency hit vs first send vs gate skip).
    const toast = page
      .locator('.aura-toast')
      .first();
    await expect(toast).toBeVisible({ timeout: 10_000 });

    // J10-M11: tightened the toast variant assertion from a
    // permissive 7-variant regex to the 2 outcomes that should ever
    // fire under healthy seed state (admin manually clicks Send for
    // a freshly-seeded cycle):
    //   1. "Reminder sent" — first dispatch (cold seed, no prior
    //      reminder_event row)
    //   2. "Already sent {ago}" — replay (test re-run within
    //      idempotency window, prior row exists)
    // If the seed got into any other state (gate skip, transient
    // failure, rate-limit) the test should fail — the original
    // wide regex would have silently passed.
    const toastText = (await toast.textContent()) ?? '';
    expect(toastText.length).toBeGreaterThan(0);
    expect(toastText).toMatch(/Reminder sent|Already sent/i);
  });

  test('the row "Send reminder" button is keyboard-reachable from the row trigger', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await page.waitForLoadState('networkidle');

    const { rowMenuTrigger, sendReminderButton } = await firstRowReminderControls(page);

    // The button sits immediately before the ⋯ trigger in the row's tab
    // order, so Shift+Tab from the trigger lands on it — reached by
    // keyboard alone, without firing the reminder.
    await rowMenuTrigger.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(sendReminderButton).toBeFocused();
  });
});
