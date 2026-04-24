/**
 * T046 — E2E: Payment card happy path (Stripe Elements + pay-sheet).
 *
 * Spec authority:
 *   - specs/009-online-payment/spec.md US1, FR-025, FR-028(a–j)
 *   - specs/009-online-payment/ux-phase3-contract.md § 2.2 (C-A shimmer contract)
 *   - specs/009-online-payment/ux-phase3-contract.md § 2.2 rule 7
 *     (data-testid="pay-sheet-card-skeleton" MUST be present in first 300ms)
 *
 * Flow:
 *   1. Sign in as member fixture (E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD).
 *   2. Navigate to /portal/invoices/[id] (E2E_ISSUED_INVOICE_ID).
 *   3. Click the Pay-now CTA button.
 *   4. Assert the payment Sheet drawer opens.
 *   5. Assert data-testid="pay-sheet-card-skeleton" is visible within 300 ms
 *      of sheet open (ux-phase3-contract.md § 2.2 rule 7 + C-A).
 *   6. Assert Stripe Elements iframe origin is js.stripe.com (FR-025).
 *   7. Fill test card 4242 4242 4242 4242 via Stripe iframe.
 *   8. Submit; expect confirmation panel + portal.payment.success.downloadReceipt CTA.
 *   9. Assert audit chain exists (payment_initiated → payment_succeeded → invoice_paid).
 *
 * STATUS: test.fixme() — member fixture, /portal/invoices/[id] page, and
 * PaySheet component do NOT exist yet. This test compiles and passes
 * typecheck but is permanently skipped until the listed tasks ship.
 *
 * UNSKIP IN: T076 (member portal invoices page), T079 (PaySheet drawer),
 * T081 (Stripe Elements wiring + confirmation panel). Also requires:
 *   - T073 (useMinDelay hook) — shimmer skeleton hook
 *   - T082 (E2E member fixture seeded in global-setup.ts)
 *   - T083 (E2E_ISSUED_INVOICE_ID env var set in vercel.json + .env.local)
 *
 * workers=1: per project memory — default 3 hangs the dev machine.
 * Enforce via playwright.config.ts `projects[].use.workers` or the
 * `--workers=1` flag when running this suite in isolation.
 */
// T082: swap `test` for `memberTest` so the E2E member is auto-signed-in
// before each spec body. Removes the inline sign-in boilerplate that
// every test used to repeat.
import { memberTest as test, expect } from './helpers/member-session';

// ---------------------------------------------------------------------------
// Environment: sign-in credentials + a pre-seeded issued invoice ID
// ---------------------------------------------------------------------------

// Sign-in credentials are consumed by the `memberTest` fixture (see
// `./helpers/member-session.ts`). We only need the issued-invoice id
// here — specs navigate directly to the detail page.
const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

// ---------------------------------------------------------------------------
// Suite: payment card happy path
//
// All tests in this suite are wrapped in test.fixme() because the required
// components (member portal, PaySheet, Stripe Elements) don't exist yet.
// test.fixme() marks them as "expected to fail / not yet implemented" —
// they compile + typecheck but are skipped without failing CI.
//
// TODO unskip: T076 + T079 + T081 + T082 + T083 (see header comment above)
// ---------------------------------------------------------------------------

test.describe('payment card happy path — @payment @e2e (T046)', () => {
  // T082 unskipped: sign-in handled by `memberTest` fixture; ISSUED
  // invoice seeded deterministically. Skip cleanly when the fixture
  // env var is absent instead of failing ambiguously.
  test.skip(
    !ISSUED_INVOICE_ID,
    'E2E_ISSUED_INVOICE_ID missing from .env.local — run `pnpm tsx scripts/seed-e2e-portal-invoices.ts` and `pnpm seed:f5-e2e`.',
  );

  test('pay-sheet opens and skeleton is visible within 300 ms of sheet open (C-A shimmer contract)', async ({
    page,
  }) => {
    // T046 is fixme'd at suite level — this body will only run when unskipped.
    // The assertions below are written now so the implementer has a clear
    // spec to satisfy (TDD: failing spec authored before implementation).

    // T082: sign-in handled by `memberTest` fixture. Navigate straight
    // to the issued invoice.
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}`);
    await page.waitForLoadState('networkidle');

    // Step 3: Click Pay-now CTA
    await page.getByRole('button', { name: /pay|pay now|pay invoice/i }).click();

    // Step 4: Sheet drawer must open
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    // Step 5: Skeleton must be visible WITHIN 300 ms of sheet open
    // ux-phase3-contract.md § 2.2 rule 7: data-testid="pay-sheet-card-skeleton"
    // must be present before Stripe Elements fires its `ready` event.
    // We measure from the moment the sheet becomes visible.
    const skeletonVisible = await page
      .getByTestId('pay-sheet-card-skeleton')
      .isVisible();
    expect(skeletonVisible).toBe(true);

    // Explicit timing assertion: skeleton present at T+0 (synchronously
    // after sheet opens). The 300 ms minimum display duration is enforced
    // by useMinDelay(300) in the component — we don't need to wait 300 ms
    // to assert presence; we just need it to be there immediately.
    const skeletonLocator = page.getByTestId('pay-sheet-card-skeleton');
    await expect(skeletonLocator).toBeVisible({ timeout: 300 });

    // ARIA contract (ux-phase3-contract.md § 2.2 rule 6)
    await expect(skeletonLocator).toHaveAttribute('aria-busy', 'true');
    await expect(skeletonLocator).toHaveAttribute('role', 'status');
  });

  test('Stripe Elements iframe origin is js.stripe.com (FR-025 CSP)', async ({
    page,
  }) => {
    // T082: sign-in handled by `memberTest` fixture.
    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}`);
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: /pay|pay now|pay invoice/i }).click();

    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    // Wait for Stripe Elements to load (skeleton hidden → element visible)
    await expect(page.getByTestId('pay-sheet-card-skeleton')).toBeHidden({
      timeout: 10_000,
    });

    // Assert Stripe iframe origin — FR-025 requires Stripe SDK hosted on
    // js.stripe.com; any other origin is a CSP / supply-chain violation.
    const stripeFrame = page.frameLocator('iframe[src^="https://js.stripe.com/"]').first();
    // The frame must exist (Stripe mounted Elements successfully)
    await expect(
      stripeFrame.locator('[data-elements-stable-field-name="cardNumber"], input[name*="cardnumber"], [placeholder*="1234"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('full card payment: 4242 4242 4242 4242 → confirmation panel + downloadReceipt CTA', async ({
    page,
  }) => {
    // T082: sign-in handled by `memberTest` fixture.

    await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}`);
    await page.waitForLoadState('networkidle');

    // Open pay sheet
    await page.getByRole('button', { name: /pay|pay now|pay invoice/i }).click();
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    // Wait for Stripe Elements to be ready (skeleton disappears)
    await expect(page.getByTestId('pay-sheet-card-skeleton')).toBeHidden({
      timeout: 10_000,
    });

    // Fill Stripe test card inside the Stripe iframe
    // Stripe Elements renders an iframe; we interact via frameLocator.
    const stripeFrame = page.frameLocator('iframe[src^="https://js.stripe.com/"]').first();

    const cardNumber = stripeFrame.locator(
      '[data-elements-stable-field-name="cardNumber"], input[autocomplete="cc-number"]',
    );
    await cardNumber.fill('4242 4242 4242 4242');

    const expiry = stripeFrame.locator(
      '[data-elements-stable-field-name="cardExpiry"], input[autocomplete="cc-exp"]',
    );
    await expiry.fill('12 / 27');

    const cvc = stripeFrame.locator(
      '[data-elements-stable-field-name="cardCvc"], input[autocomplete="cc-csc"]',
    );
    await cvc.fill('424');

    // Submit payment
    const [payResponse] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().includes('/api/payments/initiate') &&
          r.request().method() === 'POST',
        { timeout: 20_000 },
      ),
      sheet.getByRole('button', { name: /pay|confirm|submit/i }).click(),
    ]);
    expect(payResponse.status()).toBe(201);

    // Confirmation panel must appear
    const confirmation = page.getByRole('region', { name: /payment.*success|confirmed|paid/i });
    await expect(confirmation).toBeVisible({ timeout: 15_000 });

    // portal.payment.success.downloadReceipt CTA must be present
    // (i18n key rendered as link/button; check both roles)
    const downloadReceiptCta = page.getByRole('link', { name: /download receipt/i }).or(
      page.getByRole('button', { name: /download receipt/i }),
    );
    await expect(downloadReceiptCta).toBeVisible({ timeout: 5_000 });
  });

  test('audit chain: payment_initiated → payment_succeeded → invoice_paid exist after payment', async ({
    page,
  }) => {
    // This test verifies the audit chain from the ADMIN perspective.
    // After the happy-path payment above, an admin navigating to the
    // invoice detail page should see the audit timeline reflecting all 3 events.
    //
    // NOTE: This requires the admin audit-log UI (F1 feature) to surface
    // F5 audit event types. If the audit UI is not yet F5-aware, this
    // assertion should be downgraded to an API assertion against
    // GET /api/audit-log?invoiceId=... (implementation TBD in T076).
    //
    // For now we assert via the admin portal audit trail section.

    const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
    const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

    test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Admin credentials required for audit chain check');

    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/admin', { timeout: 30_000 });

    // Navigate to the invoice detail in admin portal
    await page.goto(`/admin/invoices/${ISSUED_INVOICE_ID!}`);
    await page.waitForLoadState('networkidle');

    // Audit timeline (F1 feature: timeline component on invoice detail)
    // must surface all 3 F5 audit events.
    const timeline = page.getByRole('list', { name: /audit|history|timeline/i });
    await expect(timeline).toBeVisible({ timeout: 5_000 });

    await expect(
      timeline.getByText(/payment.*initiated|payment_initiated/i),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      timeline.getByText(/payment.*succeeded|payment_succeeded/i),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      timeline.getByText(/invoice.*paid|invoice_paid/i),
    ).toBeVisible({ timeout: 5_000 });
  });
});
