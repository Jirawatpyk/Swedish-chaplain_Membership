/**
 * Plan-change UX (WP7) — admin member-edit plan-change confirm gate E2E.
 *
 * When an admin changes a member's plan at `/admin/members/[id]/edit`, an
 * unconditional confirm AlertDialog gates the save: it appears BEFORE any PATCH
 * fires (gate-before-request), shows old→new plan + annual fees + the billing
 * note, and only on confirm does the plan PATCH go out. A non-plan field edit
 * is not gated (covered by other specs).
 *
 * Per correction C-15 this does NOT touch `members-edit-with-bundle-warning.spec`
 * (which never submits). The member's own PATCH is STUBBED (200) so this is a
 * pure UI-contract test with no real plan mutation — idempotent + safe to
 * re-run against the shared dev Neon branch.
 *
 * Modelled on `members-edit-with-bundle-warning.spec.ts` (admin sign-in + edit
 * page) + `member-self-service-renewal.spec.ts` (route-stub pattern). Fees +
 * prices are asserted on comma-grouped digits only for ICU-separator tolerance.
 *
 * Run: `pnpm test:e2e --workers=1 members-plan-change-confirm`
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { seedF8Renewals } from './helpers/renewals-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('plan-change UX — admin member-edit plan-change confirm', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD in .env.local',
  );

  test('changing the plan opens the confirm dialog BEFORE any PATCH; confirming saves', async ({
    page,
  }) => {
    // Resolve the canonical e2e-member id (E2E Alpha Co) without hardcoding a
    // UUID — seedF8Renewals returns { memberId } for that account. Its renewal
    // side-effects are irrelevant here (this test stubs the member PATCH and
    // never touches renewals).
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'seedF8Renewals returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
    const memberId = seed.memberId;

    // Capture + stub the member PATCH so no real plan mutation happens. The
    // handler records each PATCH body so we can prove (a) the confirm dialog
    // gates BEFORE any request and (b) confirm is what fires the plan PATCH.
    const patchBodies: Array<Record<string, unknown>> = [];
    await page.route(`**/api/members/${memberId}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.continue();
        return;
      }
      patchBodies.push(
        JSON.parse(route.request().postData() ?? '{}') as Record<
          string,
          unknown
        >,
      );
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await signInAsAdmin(page);
    await page.goto(`/admin/members/${memberId}/edit`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#plan_id')).toBeVisible({ timeout: 15_000 });

    // The seeded e2e-member is on Diamond Partnership (2026). Change to a
    // cheaper, DOB-free corporate plan so client-side validation stays green.
    const trigger = page.locator('#plan_id');
    await expect(trigger).toContainText('Diamond Partnership');

    await trigger.click();
    // The edit page lists ALL active years, so pin the 2026 Premium option.
    await page
      .getByRole('option', { name: /Premium Corporate.*2026/i })
      .click();
    await expect(trigger).toContainText('Premium Corporate');

    // --- Save opens the confirm dialog; NO PATCH yet (gate-before-request) ---
    await page.getByRole('button', { name: /save changes/i }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: /confirm plan change/i }),
    ).toBeVisible();
    // old→new plan labels + annual fees + the (flag-stable) billing-note
    // heading are shown.
    await expect(dialog.getByText(/Diamond Partnership/)).toBeVisible();
    await expect(dialog.getByText(/Premium Corporate/)).toBeVisible();
    await expect(dialog.getByText(/200,000\.00/)).toBeVisible(); // diamond fee
    await expect(dialog.getByText(/36,000\.00/)).toBeVisible(); // premium fee
    await expect(
      dialog.getByText(/what this does and does not change/i),
    ).toBeVisible();
    // The gate held — nothing was PATCHed to reach the dialog.
    expect(patchBodies).toHaveLength(0);

    // --- Confirm fires exactly one plan PATCH + navigates to the detail page ---
    await Promise.all([
      page.waitForURL(
        (u) => new URL(u).pathname === `/admin/members/${memberId}`,
        { timeout: 15_000 },
      ),
      dialog.getByRole('button', { name: /change plan/i }).click(),
    ]);

    // Assert the PLAN PATCH landed (find, not [0], so an incidental member-
    // field PATCH from load-time normalization can't fail the plan assertion).
    const planPatch = patchBodies.find((b) => b.new_plan_id === 'premium');
    expect(planPatch, 'plan PATCH with new_plan_id=premium').toBeDefined();
    expect(Number(planPatch?.new_plan_year)).toBe(2026);
  });
});
