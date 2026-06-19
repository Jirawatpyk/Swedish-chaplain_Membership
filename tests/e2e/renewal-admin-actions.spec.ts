/**
 * DV-5 — E2E for the admin cycle-detail cancel-cycle + mark-paid-offline
 * dialogs (`<CycleAdminActions>` on `/admin/renewals/[cycleId]`).
 *
 * These dialogs are Base UI AlertDialog/Dialog, which deadlock under jsdom +
 * React 19 `startTransition` (the dialog-jsdom-hang memory) — so the
 * component's unit test only asserts the per-status visibility GATES, and the
 * field enable/disable rules are unit-tested as pure predicates in
 * `cycle-admin-validation.test.ts`. This spec covers what only a real browser
 * can: opening each dialog, the live field-gating, and the cancel happy-path
 * submit → success toast.
 *
 * NOT covered here (tracked follow-up): the mark-paid `f4_orphan_invoice`
 * deep-link toast — reproducing it needs fault injection (an F4 invoice
 * issued THEN the cycle-flip failing mid-transaction), which has no
 * deterministic E2E seam. The mark-paid happy-path SUBMIT is also
 * intentionally not exercised end-to-end: a real submit issues an F4 invoice
 * + completes the cycle (heavy live-Neon/Blob mutation); the validation-gate
 * test gives the dialog-interaction coverage without that side effect.
 *
 * Like the sibling pipeline-dashboard spec, this throws (not skips) on a
 * missing prerequisite so an env-config gap surfaces as a hard failure
 * (Constitution Principle VI) rather than a silent green. It is part of the
 * preview/post-deploy E2E gate, not pre-push.
 *
 * Run: pnpm test:e2e --grep "cycle admin actions" --workers=1
 * (workers=1 mandatory per feedback_e2e_workers).
 */
import { type Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { seedF8Renewals } from './helpers/renewals-seed';
import en from '../../src/i18n/messages/en.json';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

// Read fixture-dependent strings from the canonical locale so assertions
// track i18n edits instead of hard-coding copy (feedback_skip_is_not_pass).
const cd = en.admin.renewals.cycleDetail;

test.describe.configure({ timeout: 180_000 });

test.describe('F8 DV-5 — admin cycle admin actions (cancel + mark-paid)', () => {
  test.beforeAll(() => {
    if (!ADMIN_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL missing — set in .env.local before running this suite.',
      );
    }
    if (!F8_RENEWALS_ENABLED) {
      throw new Error(
        'FEATURE_F8_RENEWALS=false — set FEATURE_F8_RENEWALS=true in .env.local before running this suite.',
      );
    }
  });

  /**
   * Seed a fresh `upcoming` cycle (both controls render), sign in as admin,
   * open its detail page, and wait on the cancel trigger as the deterministic
   * "page + actions mounted" signal (role-based wait — Turbopack RSC streaming
   * races networkidle in dev).
   */
  async function gotoCycleDetail(page: Page): Promise<void> {
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'seedF8Renewals returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL in .env.local',
      );
    }
    await signInAsAdmin(page);
    await page.goto(`/admin/renewals/${seed.cycleId}`);
    await expect(
      page.getByRole('button', { name: cd.cancelCycle.button }),
    ).toBeVisible({ timeout: 15_000 });
  }

  test('cancel-cycle: open dialog → reason gates confirm → submit → success toast', async ({
    page,
  }) => {
    await gotoCycleDetail(page);

    await page.getByRole('button', { name: cd.cancelCycle.button }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    // Confirm stays disabled until a valid reason is entered.
    const confirm = dialog.getByRole('button', {
      name: cd.cancelCycle.confirm,
      exact: true,
    });
    await expect(confirm).toBeDisabled();

    await dialog
      .getByLabel(cd.cancelCycle.reasonLabel)
      .fill('E2E cancel — duplicate cycle');
    await expect(confirm).toBeEnabled();

    await confirm.click();

    // Success toast (read from en.json so the assertion tracks i18n edits).
    await expect(page.getByText(cd.cancelCycle.successToast)).toBeVisible({
      timeout: 15_000,
    });
  });

  test('mark-paid-offline: confirm disabled until reference + date are filled', async ({
    page,
  }) => {
    await gotoCycleDetail(page);

    await page
      .getByRole('button', { name: cd.markPaidOffline.button })
      .click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const confirm = dialog.getByRole('button', {
      name: cd.markPaidOffline.confirm,
      exact: true,
    });
    // payment_method defaults to bank_transfer, but reference + date are
    // empty → confirm disabled (the isMarkPaidIncomplete predicate).
    await expect(confirm).toBeDisabled();

    await dialog
      .getByLabel(cd.markPaidOffline.paymentReferenceLabel)
      .fill('bank-slip-0001');
    // Still incomplete — date missing.
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel(cd.markPaidOffline.paymentDateLabel).fill('2026-01-15');
    // All three present → enabled. NOT submitted (a real submit issues an F4
    // invoice + completes the cycle — out of scope; see file header).
    await expect(confirm).toBeEnabled();
  });
});
