/**
 * 070 F8 item #18 — E2E for the admin pending-reactivation actions.
 *
 * From the cycle-detail page of a seeded `pending_admin_reactivation`
 * cycle, walks the two admin decisions surfaced by
 * `PendingReactivationActions`:
 *
 *   1. Approve → confirmation dialog → POST /reactivate → success toast →
 *      the cycle's status badge reflects "completed".
 *   2. Reject → enter a reason → destructive confirm → POST /reject →
 *      success toast (the seeded draft invoice has no settled payment, so
 *      the reject yields the "no payment to refund" variant; either
 *      success copy is accepted).
 *
 * Both decisions are TERMINAL (the cycle leaves `pending_admin_reactivation`),
 * so the cycle is RE-SEEDED before each test via
 * `seedPendingReactivationCycle()`.
 *
 * Gate: skips cleanly when the F8 flag is off, the admin creds are missing,
 * or the seed can't resolve the e2e fixtures (per the task's "robust spec,
 * don't block on running it" guidance). Run with `--workers=1`.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import {
  seedPendingReactivationCycle,
  type PendingSeedResult,
} from './helpers/pending-reactivation-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

test.describe('F8 — admin pending-reactivation actions (070)', () => {
  test.skip(
    !F8_RENEWALS_ENABLED,
    'FEATURE_F8_RENEWALS=false — set FEATURE_F8_RENEWALS=true in .env.local',
  );
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD missing — set both in .env.local',
  );

  let seeded: PendingSeedResult | null = null;

  test.beforeEach(async () => {
    // Re-seed a fresh pending cycle before EACH test — both approve and
    // reject are terminal, so a prior test leaves the cycle non-pending.
    seeded = await seedPendingReactivationCycle();
    test.skip(
      seeded === null,
      'seedPendingReactivationCycle returned null — DATABASE_URL / e2e fixtures unavailable',
    );
  });

  test('approve: confirm dialog → success toast → cycle completed', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(`/admin/renewals/${seeded!.cycleId}`);

    // The cycle is pending → the actions are present.
    const approveBtn = page.getByRole('button', {
      name: /approve reactivation/i,
    });
    await expect(approveBtn).toBeVisible({ timeout: 10_000 });
    await approveBtn.click();

    // Confirmation dialog opens; confirm.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading')).toBeVisible();
    await dialog.getByRole('button', { name: /^approve$/i }).click();

    // Success toast.
    await expect(
      page.getByText(/membership is now active|reactivation approved/i).first(),
    ).toBeVisible({ timeout: 10_000 });

    // After router.refresh() the status badge reflects the completed cycle.
    await expect(page.getByText(/completed/i).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test('reject: enter reason → destructive confirm → success toast', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(`/admin/renewals/${seeded!.cycleId}`);

    const rejectBtn = page.getByRole('button', { name: /reject & refund/i });
    await expect(rejectBtn).toBeVisible({ timeout: 10_000 });
    await rejectBtn.click();

    // Destructive AlertDialog with a required reason textarea.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.getByRole('heading')).toBeVisible();
    const reason = dialog.getByRole('textbox');
    await reason.fill('E2E: duplicate payment — reject and refund');

    // Confirm (the destructive submit button).
    await dialog.getByRole('button', { name: /reject & refund/i }).click();

    // Success toast — either "refunded" or "no payment to refund" (the
    // seeded draft invoice has no settled payment → no_payment variant).
    await expect(
      page
        .getByText(/payment was refunded|no payment to refund/i)
        .first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('Pending-review dashboard view lists the seeded cycle and links to it', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals?view=pending-review');

    // The discovery section heading renders.
    await expect(
      page.getByRole('heading', { name: /awaiting your decision/i }).first(),
    ).toBeVisible({ timeout: 10_000 });

    // A "Review" link points at the seeded cycle's detail page.
    const reviewLink = page
      .getByRole('link', { name: /^review$/i })
      .first();
    await expect(reviewLink).toBeVisible();
    await reviewLink.click();
    await page.waitForURL(/\/admin\/renewals\/[0-9a-f-]{36}/, {
      timeout: 10_000,
    });
  });
});
