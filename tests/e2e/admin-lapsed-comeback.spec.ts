/**
 * F8-completion Slice 3 · Task 3.2 — E2E for the admin lapsed-comeback
 * journey on `/admin/members/[memberId]`.
 *
 * Closes the Constitution Principle II "every user story MUST have ≥1
 * acceptance test" gap on the reachable lapsed-comeback path. Walks:
 *   1. Admin opens a LAPSED member → the "Renew member" action is shown,
 *      clicks it, confirms the dialog → a success toast appears + the
 *      Renewal & Health card flips to "Awaiting payment" (a fresh cycle +
 *      §86/4 invoice were created server-side).
 *   2. A manager opening the SAME lapsed member does NOT see the "Renew
 *      member" action (admin-only affordance — no broken button).
 *
 * Gate: runtime-skips when FEATURE_F8_RENEWALS=false OR the required env
 * vars / DB seed are absent. Seeds a DUMMY (non-PII) lapsed member via
 * `seedLapsedMemberForComeback` — never references a real member row.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import {
  seedLapsedMemberForComeback,
  cleanupLapsedMemberComeback,
  type LapsedMemberSeed,
} from './helpers/lapsed-member-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

test.describe('F8 — admin lapsed-comeback (Slice 3 / Task 3.2)', () => {
  let seeded: LapsedMemberSeed | null = null;

  test.beforeAll(async () => {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD || !F8_RENEWALS_ENABLED) {
      // Runtime-skip: the suite cannot run without admin creds + the flag.
      return;
    }
    seeded = await seedLapsedMemberForComeback();
  });

  test.afterAll(async () => {
    // Tear down the dummy member (+ its cycles, the issued §86/4, the dummy
    // plan) from the shared `swecham` tenant. The high dummy member_number
    // is non-contiguous and would otherwise fail the migration-0209
    // member-number-contiguity check on the next members-integration run.
    await cleanupLapsedMemberComeback();
  });

  test('admin renews a lapsed member — Renew action → confirm → cycle becomes awaiting_payment', async ({
    page,
  }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD || !F8_RENEWALS_ENABLED || seeded === null,
      'E2E_ADMIN_* / FEATURE_F8_RENEWALS / DB seed missing — set them in .env.local to run this suite.',
    );

    await signInAsAdmin(page);
    await page.goto(`/admin/members/${seeded!.memberId}`);

    // The Renewal & Health card is visible; the member is lapsed.
    const renewalRegion = page.getByRole('region', {
      name: /renewal.*health|health.*renewal/i,
    });
    await expect(renewalRegion).toBeVisible({ timeout: 15_000 });

    // The admin-only "Renew member" action is present for a lapsed member.
    const renewButton = page.getByRole('button', { name: /renew member/i });
    await expect(renewButton).toBeVisible();
    await renewButton.click();

    // The confirmation dialog explains the side effect (creates an invoice).
    // Assert on the description copy specifically — phrase unique to the
    // <p> body (not the "Create renewal invoice" confirm button).
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(/new membership year|invoice for them to pay/i),
    ).toBeVisible();

    // Confirm — POSTs to /api/admin/members/[id]/renew.
    await dialog.getByRole('button', { name: /create renewal invoice/i }).click();

    // Success toast appears.
    await expect(
      page.getByText(/renewal invoice created/i),
    ).toBeVisible({ timeout: 15_000 });

    // After router.refresh(), the card reflects the fresh awaiting_payment
    // cycle (the most-recent cycle is now the new payable one).
    await expect(
      renewalRegion.getByText(/awaiting payment/i),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('manager does NOT see the Renew action on a lapsed member', async ({
    page,
  }) => {
    test.skip(
      !MANAGER_EMAIL ||
        !MANAGER_PASSWORD ||
        !F8_RENEWALS_ENABLED ||
        seeded === null,
      'E2E_MANAGER_* / FEATURE_F8_RENEWALS / DB seed missing — set them in .env.local to run this suite.',
    );

    await signInAsManager(page);
    await page.goto(`/admin/members/${seeded!.memberId}`);

    const renewalRegion = page.getByRole('region', {
      name: /renewal.*health|health.*renewal/i,
    });
    await expect(renewalRegion).toBeVisible({ timeout: 15_000 });

    // The Renew action is admin-only — a manager never sees it.
    await expect(
      page.getByRole('button', { name: /renew member/i }),
    ).toHaveCount(0);
  });
});
