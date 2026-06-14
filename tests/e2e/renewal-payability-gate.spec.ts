/**
 * F8-completion slice 2 · Task 2.6 (G4) — portal renewal payability gate.
 *
 * The `/portal/renewal/[memberId]` page now branches on the cycle's
 * `summary.status`:
 *   - `awaiting_payment` → renders <RenewalConfirmFlow> (the Confirm CTA).
 *   - `upcoming | reminded` → renders a read-only "renewal window not
 *     yet open" card (NO enabled Confirm button).
 *   - `pending_admin_reactivation` → an "awaiting admin verification"
 *     notice.
 *
 * This spec exercises the two reachable launch states end-to-end:
 *   1. an `upcoming` cycle renders the read-only not-yet-open state with
 *      no enabled Confirm button;
 *   2. an `awaiting_payment` cycle renders the Confirm flow.
 *
 * The server gate (`confirmRenewal` → 409 cycle_not_payable) stays the
 * backstop; this is the presentation-layer reinforcement so a member
 * never sees a Confirm button they can't use.
 *
 * Tests skip at runtime when env fixtures absent (matches the F8
 * renewal-i18n.spec.ts pattern). Read fixture-dependent strings from the
 * live en.json so the assertion follows i18n edits.
 *
 * Run: pnpm test:e2e --workers=1 --grep "payability gate"
 * (workers=1 mandatory per feedback_e2e_workers).
 */
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';
import { seedF8Renewals } from './helpers/renewals-seed';
import { setCycleStatusForSuccessE2E } from './helpers/renewal-success-state';
import en from '../../src/i18n/messages/en.json';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

// Read the gate copy from the canonical locale so the assertions track
// i18n edits instead of hard-coding strings (feedback_skip_is_not_pass).
const notYetOpenTitle = en.portal.renewal.notYetOpenTitle;

test.describe.configure({ timeout: 180_000 });

test.describe('F8 — portal renewal payability gate (G4, Task 2.6)', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD,
    'Set E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD to run the payability-gate E2E',
  );

  test('an `upcoming` cycle renders the read-only not-yet-open state (no enabled Confirm)', async ({
    page,
  }) => {
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'seedF8Renewals returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL in .env.local',
      );
    }
    // seedF8Renewals mints the cycle in `upcoming` — that is exactly the
    // not-yet-open state we want to assert here, so no status mutation.
    await setCycleStatusForSuccessE2E(seed.cycleId, 'upcoming');

    await signInAsMember(page);
    await page.goto(`/portal/renewal/${seed.memberId}`);
    await page.waitForLoadState('networkidle');

    // Page heading still renders (PageHeader is status-independent).
    await expect(
      page.getByRole('heading', { name: /online renewal/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The read-only not-yet-open card is shown (gate copy from en.json).
    await expect(page.getByText(notYetOpenTitle)).toBeVisible();

    // No enabled Confirm button — the member cannot pay a non-payable cycle.
    const confirmBtn = page.getByRole('button', { name: /confirm renewal/i });
    await expect(confirmBtn).toHaveCount(0);
  });

  test('an `awaiting_payment` cycle renders the Confirm flow', async ({
    page,
  }) => {
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'seedF8Renewals returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL in .env.local',
      );
    }
    // Flip the seeded cycle to `awaiting_payment` so the page renders the
    // Confirm flow (the post-T-0 / post-confirm-lazy payable state).
    await setCycleStatusForSuccessE2E(seed.cycleId, 'awaiting_payment');

    await signInAsMember(page);
    await page.goto(`/portal/renewal/${seed.memberId}`);
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: /online renewal/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The Confirm flow is shown + the CTA is enabled.
    const confirmBtn = page.getByRole('button', { name: /confirm renewal/i });
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toBeEnabled();

    // The not-yet-open gate copy is NOT shown for a payable cycle.
    await expect(page.getByText(notYetOpenTitle)).toHaveCount(0);
  });
});
