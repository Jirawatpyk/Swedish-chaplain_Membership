/**
 * F8 Phase 5 Wave E · T150 — Member self-service renewal E2E (US3 AS1, AS6).
 *
 * Coverage strategy:
 *   - AS1 (member receives reminder + clicks "Renew now") — partial:
 *     this spec exercises the post-token-verified entry where the
 *     session is already established. The token-verify→sign-in
 *     handler is a follow-on (research.md R1 v2 step 9).
 *   - AS2 (review benefit summary + frozen price) — covered HERE:
 *     page renders the cycle summary card with frozen price, term,
 *     expiry, and the benefit-summary fallback panel.
 *   - AS3 (first-time renewer onboarding banner) — covered HERE:
 *     `summary.isFirstTimeRenewer === true` (MVP default) shows
 *     the banner.
 *   - AS6 (confirm CTA visible + clickable) — covered HERE: the
 *     "Confirm renewal" button is present + enabled.
 *
 * Out of scope for E2E:
 *   - AS4 (Stripe pay redirect) — needs F5 Stripe live test infra
 *     (existing F5 specs handle this).
 *   - AS5 (success page after payment) — needs full F4+F5+F8 chain
 *     covered by T145 self-service-renewal-tx (deferred).
 *   - AS7 (token-replay reject) — covered by T144 integration test.
 *
 * Gate: `FEATURE_F8_RENEWALS=false` skips. Sign-in env vars required.
 *
 * Run: `pnpm test:e2e --grep "self-service-renewal" --workers=1`
 * (workers=1 mandatory per memory feedback_e2e_workers).
 */
import { expect } from './fixtures';
import { memberTest as test } from './helpers/member-session';
import { seedF8Renewals } from './helpers/renewals-seed';
import { setCycleStatusForSuccessE2E } from './helpers/renewal-success-state';

test.describe('F8 — member self-service renewal portal (US3 AS1+AS2+AS3+AS6, T150)', () => {
  test('renders cycle summary + onboarding banner + confirm CTA', async ({
    page,
  }) => {
    // Re-seed F8 renewals to ensure the e2e-member has an active cycle
    // in `awaiting_payment` status so the renewal page has data to
    // render. Idempotent — safe to re-run. Constitution Principle VI
    // (UX consistency) requires this E2E to actually exercise the page,
    // so we throw on missing prerequisites instead of skipping.
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'F8 renewals seed returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
    // G4 (slice 2.6) — the renewal page now gates the Confirm flow on a
    // PAYABLE cycle. seedF8Renewals mints an `upcoming` cycle, which the
    // gate correctly renders as the read-only "not yet open" state. This
    // spec asserts the Confirm flow, so flip the seeded cycle to
    // `awaiting_payment` first (the post-T-0 / post-confirm payable state).
    await setCycleStatusForSuccessE2E(seed.cycleId, 'awaiting_payment');

    // Navigate to the public renewal page for the seeded member. The
    // page calls findActiveForMember which returns the awaiting_payment
    // cycle seeded above.
    await page.goto(`/portal/renewal/${seed.memberId}`);
    await page.waitForLoadState('networkidle');

    // AS1+AS2 — page heading visible.
    await expect(
      page.getByRole('heading', { name: /online renewal/i }),
    ).toBeVisible({ timeout: 15_000 });

    // AS3 — onboarding banner visible (isFirstTimeRenewer defaults
    // to true in MVP). Aria-label is the localised heading
    // "Welcome to your first renewal" (EN) per
    // `portal.renewal.onboarding.heading` i18n key.
    await expect(
      page.getByRole('region', { name: /welcome.*first renewal/i }),
    ).toBeVisible();

    // AS2 — frozen plan summary card visible. The seed uses
    // 50000.00 THB / 12 months / regular tier. The page formats the
    // frozen price via Intl currency (`formatter.number(..., {style:
    // 'currency'})`) → renders grouped, e.g. "THB 50,000.00" — so match
    // the grouped amount, not the raw "50000.00" (which never renders).
    await expect(
      page.getByRole('heading', { name: /membership plan/i }),
    ).toBeVisible();
    await expect(page.getByText(/50,000\.00/)).toBeVisible();
    await expect(page.getByText('12 months')).toBeVisible();

    // Benefit summary fallback (benefitsAvailable=false in MVP).
    await expect(
      page.getByText(/benefit summary unavailable/i),
    ).toBeVisible();

    // AS6 — confirm CTA visible + enabled.
    const confirmBtn = page.getByRole('button', { name: /confirm renewal/i });
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toBeEnabled();
  });

  test('I12 review-fix: clicking confirm posts to API + redirects to /portal/billing/<invoiceId>/pay', async ({
    page,
  }) => {
    // Lock AS6 contract: clicking the "Confirm renewal" button triggers
    // a POST to `/api/portal/renewal/<memberId>/confirm`, the response
    // contains `pay_url`, and the browser navigates there. Use a route
    // intercept to fulfil the API with a deterministic pay_url so the
    // test does not depend on Stripe / F4 invoice creation chain (those
    // live in T145 + F4/F5 integration suites).
    const seed = await seedF8Renewals();
    if (!seed) {
      throw new Error(
        'F8 renewals seed returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
    // G4 (slice 2.6) — flip the seeded `upcoming` cycle to a payable
    // `awaiting_payment` state so the Confirm flow renders past the gate.
    await setCycleStatusForSuccessE2E(seed.cycleId, 'awaiting_payment');

    const fakeInvoiceId = 'inv-e2e-i12-fixture';
    const fakePayUrl = `/portal/billing/${fakeInvoiceId}/pay`;

    // Intercept the F8 confirm endpoint with a stub success envelope.
    // Letting it hit production would create a real F4 invoice for the
    // seed member which then fails T145's idempotent re-seed.
    await page.route(
      `**/api/portal/renewal/${seed.memberId}/confirm`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            invoice_id: fakeInvoiceId,
            invoice_number: 'INV-2026-E2E-0001',
            pay_url: fakePayUrl,
            plan_changed: false,
          }),
        });
      },
    );

    // Stub the redirected billing/pay page so the test does not 404
    // against the F5 surface (which depends on a real invoice id).
    await page.route(`**${fakePayUrl}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html lang="en"><body><h1 data-testid="i12-pay-stub">F5 pay stub</h1></body></html>',
      });
    });

    await page.goto(`/portal/renewal/${seed.memberId}`);
    await page.waitForLoadState('networkidle');

    const confirmBtn = page.getByRole('button', { name: /confirm renewal/i });
    await expect(confirmBtn).toBeEnabled();

    await Promise.all([
      page.waitForURL(`**${fakePayUrl}`, { timeout: 15_000 }),
      confirmBtn.click(),
    ]);

    await expect(
      page.getByTestId('i12-pay-stub'),
    ).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toContain(fakePayUrl);
  });
});
