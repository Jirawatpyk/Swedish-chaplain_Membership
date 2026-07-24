/**
 * Plan-change UX (WP3–WP5) — member portal renewal DOWNGRADE gate E2E (P0).
 *
 * A member whose active renewal cycle is on a HIGHER-priced plan (`premium`,
 * 36,000.00 THB) opens `/portal/renewal/[memberId]`, sees the always-rendered
 * price-diff panel + the grouped plan picker, selects a strictly CHEAPER plan
 * (`regular`, 16,000.00 THB), and is stopped by the two-step downgrade
 * AlertDialog. Cancelling posts NOTHING; confirming posts with
 * `acknowledgeDowngrade: true` and proceeds to the pay step.
 *
 * The client dialog mirrors the server gate (`confirmRenewal` → 409
 * `downgrade_not_acknowledged`), classified by the SAME
 * `classifyPlanPriceChange` predicate both sides share, so they cannot diverge.
 *
 * Seed: `seedF8Renewals({ planId: 'premium', frozenPlanPriceThb: '36000.00' })`
 * mints the active cycle on premium (frozen at the premium catalogue fee) so
 * every cheaper corporate plan lands in the "Lower-priced plans" group. The
 * cycle is then flipped to `awaiting_payment` (payable) so the Confirm flow
 * renders past the payability gate — same pattern as
 * `member-self-service-renewal.spec.ts`.
 *
 * Gate: `FEATURE_F8_RENEWALS=false` → describe-level skip. Member sign-in env
 * vars required (memberTest fixture). Prices are asserted on comma-grouped
 * digits only so ICU's narrow/no-break separators + the ฿ symbol stay tolerant
 * across builds.
 *
 * Run: `pnpm test:e2e --workers=1 portal-renewal-downgrade`
 */
import { expect } from './fixtures';
import { memberTest as test } from './helpers/member-session';
import { seedF8Renewals } from './helpers/renewals-seed';
import { setCycleStatusForSuccessE2E } from './helpers/renewal-success-state';

const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';
const describeBlock = F8_RENEWALS_ENABLED ? test.describe : test.describe.skip;

// premium `annual_fee_minor_units` = 3_600_000 → freeze the cycle at the same
// major-baht value so the current plan reads coherently and every strictly
// cheaper corporate plan is a downgrade relative to it.
const PREMIUM_FROZEN_THB = '36000.00';

describeBlock('plan-change UX — portal renewal downgrade gate', () => {
  test('cheaper plan is gated by the two-step downgrade dialog; confirm posts the ack, cancel posts nothing', async ({
    page,
  }) => {
    const seed = await seedF8Renewals({
      planId: 'premium',
      tier: 'premium',
      frozenPlanPriceThb: PREMIUM_FROZEN_THB,
    });
    if (!seed) {
      throw new Error(
        'seedF8Renewals returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
    // The Confirm flow renders only for a PAYABLE cycle; flip the seeded
    // `upcoming` cycle to `awaiting_payment` (the post-T-0 payable state).
    await setCycleStatusForSuccessE2E(seed.cycleId, 'awaiting_payment');

    // Stub the confirm POST so no real F4 invoice is created, and RECORD each
    // call's body — the two-step contract is: ZERO calls to reach/leave the
    // dialog via Cancel, exactly ONE (carrying the ack) after Confirm.
    const fakePayUrl = `/portal/invoices/inv-e2e-downgrade-fixture?pay=1`;
    const confirmBodies: Array<Record<string, unknown>> = [];
    await page.route(
      `**/api/portal/renewal/${seed.memberId}/confirm`,
      async (route) => {
        confirmBodies.push(
          JSON.parse(route.request().postData() ?? '{}') as Record<
            string,
            unknown
          >,
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            invoice_id: 'inv-e2e-downgrade-fixture',
            invoice_number: 'INV-2026-E2E-DG-0001',
            pay_url: fakePayUrl,
            plan_changed: true,
          }),
        });
      },
    );
    // Stub the redirect target so the post-confirm navigation doesn't 404.
    await page.route(`**${fakePayUrl}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><body><h1 data-testid="downgrade-pay-stub">pay stub</h1></body></html>',
      });
    });

    await page.goto(`/portal/renewal/${seed.memberId}`);
    await page.waitForLoadState('networkidle');

    // The price panel renders ALWAYS (outside `hasAlternatives`, C-6): the
    // current locked-in premium price is visible at rest.
    await expect(page.getByTestId('price-diff-panel')).toBeVisible();
    await expect(page.getByTestId('price-current')).toContainText(/36,000\.00/);

    // Grouped picker — open it and assert the current + lower-priced groups.
    const planSelect = page.getByRole('combobox', { name: /choose a plan/i });
    await expect(planSelect).toBeVisible();
    await expect(planSelect).toContainText('Premium Corporate');
    await planSelect.click();

    await expect(page.getByText('Your current plan')).toBeVisible();
    await expect(page.getByText('Lower-priced plans')).toBeVisible();

    // Options carry their price — the Regular option shows 16,000.00.
    const regularOption = page.getByRole('option', {
      name: /Regular Corporate/i,
    });
    await expect(regularOption).toContainText(/16,000\.00/);
    await regularOption.click();

    // Diff panel updates live: new = 16,000.00 and the delta shows the drop.
    await expect(page.getByTestId('price-new')).toContainText(/16,000\.00/);
    await expect(page.getByTestId('price-delta')).toContainText(/20,000\.00/);

    // --- Confirm opens the downgrade dialog (NOT an immediate submit) ---
    const confirmBtn = page.getByRole('button', { name: /confirm renewal/i });
    await confirmBtn.click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // AlertDialogTitle IS a heading (base-ui), unlike shadcn CardTitle.
    await expect(
      dialog.getByRole('heading', { name: /confirm a lower-priced plan/i }),
    ).toBeVisible();
    // The gate held: no POST fired to reach the dialog.
    expect(confirmBodies).toHaveLength(0);

    // --- Cancel keeps the current plan + posts NOTHING ---
    await dialog
      .getByRole('button', { name: /keep my current plan/i })
      .click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    expect(confirmBodies).toHaveLength(0);
    // Still on the renewal page (no navigation on cancel).
    expect(new URL(page.url()).pathname).toBe(
      `/portal/renewal/${seed.memberId}`,
    );

    // --- Re-open + confirm proceeds to the pay step WITH the ack flag ---
    await confirmBtn.click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await Promise.all([
      page.waitForURL(`**${fakePayUrl}`, { timeout: 15_000 }),
      page
        .getByRole('alertdialog')
        .getByRole('button', { name: /yes, switch to this plan/i })
        .click(),
    ]);
    await expect(page.getByTestId('downgrade-pay-stub')).toBeVisible({
      timeout: 15_000,
    });

    // The single confirm POST carried the downgrade acknowledgement + target.
    expect(confirmBodies).toHaveLength(1);
    expect(confirmBodies[0]).toMatchObject({
      newPlanId: 'regular',
      acknowledgeDowngrade: true,
    });
  });
});
