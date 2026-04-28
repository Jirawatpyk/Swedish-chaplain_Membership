/**
 * T085 — E2E: PaySheet drawer viewport + mobile layout verification.
 *
 * Spec authority:
 *   - specs/009-online-payment/spec.md FR-028h (mobile responsiveness):
 *       < 640 px → full-screen drawer
 *       ≥ 640 px → right-aligned drawer, max-width 480 px
 *   - specs/009-online-payment/plan.md § UX Mobile responsiveness matrix
 *     (3 viewport presets: iPhone SE 320×568, iPad 768×1024, FHD 1920×1080)
 *   - WCAG 2.1 SC 2.5.5 / WCAG 2.2 SC 2.5.8 — tap target ≥ 44×44 px
 *   - WCAG 2.2 SC 2.4.11 — Focus Not Obscured (sticky header + scroll-padding)
 *   - specs/009-online-payment SC-012 — zero serious/critical axe violations
 *
 * Scope: LAYOUT only. The full initiate → Stripe Elements interaction
 * flow lives in `payment-card-happy-path.spec.ts` (unskips once the
 * member fixture + issued-invoice seeder lands in Phase 4 member-work).
 *
 * Fixture strategy: the member-session auth fixture is not yet seeded
 * (tracked under T082 alongside the happy-path spec). Rather than build
 * throwaway auth infra inline, the viewport assertions are authored as
 * TDD scaffolding with `test.fixme()` gates at suite level so they
 * typecheck + lint clean, document the concrete contract, and unskip
 * atomically with T082 once the member fixture is available. The route
 * stub for `POST /api/payments/initiate` is wired inline so LAYOUT
 * assertions don't transitively depend on Stripe — only the session
 * cookie blocks the unskip.
 *
 * workers=1: per project memory — Playwright default of 3 hangs the
 * dev workstation. Always pass `--workers=1` when running this suite.
 */
import AxeBuilder from '@axe-core/playwright';
import { devices, type Page } from '@playwright/test';
// T082: swap `test` for `memberTest` so the E2E member is auto-signed-in
// before each spec body. `expect` re-exported from the same module.
import { memberTest as test, expect } from './helpers/member-session';
// T082b: stub `window.Stripe` so card-submit drives the state machine
// into `success` without a real js.stripe.com iframe or Stripe test
// account. See helpers/stripe-mock.ts for the interception contract.
import { stubStripeConfirmSuccess } from './helpers/stripe-mock';

// ---------------------------------------------------------------------------
// Environment & fixtures
// ---------------------------------------------------------------------------

// Sign-in credentials are consumed by the `memberTest` fixture (see
// `./helpers/member-session.ts`). We only read `E2E_ISSUED_INVOICE_ID`
// here — the URL path parameter for the seeded pay-sheet invoice.
const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

// 3 viewport presets per plan.md § UX Mobile responsiveness matrix.
// We use the Playwright `devices` descriptors where they exist so the
// user-agent + deviceScaleFactor + hasTouch flags match real hardware;
// the FHD desktop size is a plain viewport (no device preset needed).
const VIEWPORTS = [
  {
    label: 'iPhone SE (320×568, smallest supported)',
    width: 320,
    height: 568,
    device: devices['iPhone SE'],
    isMobile: true,
  },
  {
    label: 'iPad portrait (768×1024, sm breakpoint boundary)',
    width: 768,
    height: 1024,
    device: devices['iPad (gen 7)'],
    isMobile: false,
  },
  {
    label: 'FHD desktop (1920×1080)',
    width: 1920,
    height: 1080,
    device: undefined,
    isMobile: false,
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stub `POST /api/payments/initiate` with a fixture response so LAYOUT
 * assertions don't require a real Stripe account. The shape matches
 * `InitiateResponse` in `pay-sheet-internal.tsx`.
 */
async function stubInitiateEndpoint(page: Page): Promise<void> {
  await page.route('**/api/payments/initiate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        payment: { id: 'pay_test_layout' },
        stripe: {
          // Stripe SDK validates secret length; stub uses ≥24-char tail to satisfy regex.
          clientSecret: 'pi_3OXTestLayout00000000_secret_test000000000000000000000000',
          publishableKey: 'pk_test_layout',
          paymentIntentId: 'pi_test_layout',
          promptpayQrSvgUrl: null,
        },
        correlationId: 'test-correlation-layout',
      }),
    });
  });
  // PaySheet calls `/cancel` on close (FR-028 cancel-on-close). The stub
  // payment id `pay_test_layout` does not exist in the DB, so the real
  // route returns 400. Layout-only viewport assertions don't care about
  // server state, so short-circuit with 200 to keep the console clean.
  await page.route('**/api/payments/pay_test_layout/cancel', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, kind: 'canceled-by-user' }),
    });
  });
}

/**
 * Sign the member fixture in and open the pay sheet via ?pay=1 deep link
 * (FR-025c). This is the shared preamble for every viewport assertion.
 */
async function openPaySheet(page: Page): Promise<void> {
  // T082: member sign-in is handled by the `memberTest` fixture. The
  // page arrives here already on `/portal` with a valid session cookie.
  await stubInitiateEndpoint(page);
  await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID!}?pay=1`);
  await page.waitForLoadState('networkidle');

  const sheet = page.getByTestId('pay-sheet-content');
  await expect(sheet).toBeVisible({ timeout: 5_000 });
}

/**
 * Assert a locator's rendered box is at least `min` px on each axis.
 * Used for tap-target checks (WCAG 2.5.5 / 2.5.8 = 44 px minimum).
 */
async function expectMinTapTarget(
  page: Page,
  testId: string,
  min = 44,
): Promise<void> {
  const locator = page.getByTestId(testId);
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${testId} must have a rendered bounding box`).not.toBeNull();
  expect(box!.width, `${testId} width ≥ ${min}px`).toBeGreaterThanOrEqual(min);
  expect(box!.height, `${testId} height ≥ ${min}px`).toBeGreaterThanOrEqual(min);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('PaySheet viewport + mobile layout — @payment @a11y @f5', () => {
  // T082 unskipped: sign-in is driven by `memberTest` fixture; the
  // ISSUED invoice is seeded with a deterministic id. We still skip
  // (not fail) when `E2E_ISSUED_INVOICE_ID` is absent so CI runs on
  // branches that haven't re-seeded still go green — the assertion
  // surfaces as a clear skip message rather than a misleading fail.
  test.skip(
    !ISSUED_INVOICE_ID,
    'E2E_ISSUED_INVOICE_ID missing from .env.local — run `pnpm tsx scripts/seed-e2e-portal-invoices.ts` and `pnpm seed:f5-e2e`, then add the printed env var.',
  );

  for (const preset of VIEWPORTS) {
    test.describe(preset.label, () => {
      test.use({
        viewport: { width: preset.width, height: preset.height },
        ...(preset.device
          ? {
              userAgent: preset.device.userAgent,
              deviceScaleFactor: preset.device.deviceScaleFactor,
              hasTouch: preset.device.hasTouch,
              isMobile: preset.device.isMobile,
            }
          : {}),
      });

      test('drawer opens + occupies correct layout (FR-028h)', async ({ page }) => {
        await openPaySheet(page);

        const sheet = page.getByTestId('pay-sheet-content');
        const box = await sheet.boundingBox();
        expect(box, 'sheet must have a rendered bounding box').not.toBeNull();

        if (preset.width < 640) {
          // Full-screen on < 640 px: 100% width, 100% height.
          // mobile-a11y reviewer W-02 caveat (2026-04-24): on real iOS
          // Safari the visual viewport is smaller than the layout
          // viewport by the URL-bar offset (~36 px on iPhone SE).
          // Playwright headless has no URL bar, so `preset.height`
          // equals visual height exactly; this assertion holds in CI
          // but MUST be re-verified on a real device during Group H
          // manual smoke. If the drawer uses `100vh` it will clip
          // behind the URL bar on real iOS — the fix is `100dvh` (we
          // currently use Tailwind `h-full` which resolves to `100%`
          // of the parent, NOT `100vh`, so this caveat is advisory
          // rather than a known bug today).
          // T082 empirical E2E discovery (2026-04-24): headless Chromium
          // renders a ~15 px desktop-style vertical scrollbar, so
          // `width: 100%` resolves to `viewport - 15 = 305 px` on a
          // 320 px viewport. Real iOS Safari uses overlay scrollbars
          // that don't reserve space, so production renders true 320 px.
          // Tolerate the 20 px scrollbar delta in headless runs; the
          // spec contract is "spans full viewport width minus
          // scrollbar reservation if any".
          expect(
            box!.width,
            `mobile drawer spans full viewport width (± scrollbar): got ${box!.width}, expected ≥ ${preset.width - 20}`,
          ).toBeGreaterThanOrEqual(preset.width - 20);
          expect(box!.height, 'mobile drawer spans full viewport height').toBe(
            preset.height,
          );
        } else {
          // Right-drawer on ≥ 640 px: capped at 480 px width, full-height.
          // FR-028h was revised 2026-04-24 (see pay-sheet/index.tsx:401-409):
          // drawer is now pinned top-to-bottom (100vh) on BOTH mobile and
          // desktop — Stripe Dashboard / Linear side-panel pattern. The
          // payment flow transitions between states (card → 3DS →
          // confirmation) with different natural heights; auto-height
          // would cause the drawer to jump. Full-viewport height gives a
          // stable container with a sticky header + scrollable body.
          // Only width differs between mobile (full) and desktop (≤480 px).
          expect(
            box!.width,
            'desktop drawer width ≤ 480 px (sm:max-w-[480px])',
          ).toBeLessThanOrEqual(480);
          expect(
            box!.height,
            'desktop drawer height spans full viewport (revised FR-028h: 100vh on both viewports)',
          ).toBe(preset.height);
        }
      });

      test('close button tap target ≥ 44×44 px (SC 2.5.5 / 2.5.8)', async ({
        page,
      }) => {
        await openPaySheet(page);
        await expectMinTapTarget(page, 'pay-sheet-close');
      });

      test('sticky header remains pinned during drawer-body scroll (SC 2.4.11)', async ({
        page,
      }) => {
        test.skip(
          preset.width >= 640,
          'Sticky-header scroll test is mobile-only (full-screen drawer).',
        );
        await openPaySheet(page);

        const headerTopBefore = await page
          .getByTestId('pay-sheet-content')
          .locator('[data-slot="sheet-header"]')
          .evaluate((el) => el.getBoundingClientRect().top);

        // Scroll the drawer body. `overflow-y-auto` wraps the inner panel.
        await page
          .getByTestId('pay-sheet-content')
          .locator('.overflow-y-auto')
          .evaluate((el) => {
            el.scrollTop = 200;
          });

        const headerTopAfter = await page
          .getByTestId('pay-sheet-content')
          .locator('[data-slot="sheet-header"]')
          .evaluate((el) => el.getBoundingClientRect().top);

        // A sticky header's viewport-relative `top` stays constant as
        // the body scrolls under it. Allow 1 px fuzz for sub-pixel
        // rendering on device-scale viewports.
        expect(
          Math.abs(headerTopAfter - headerTopBefore),
          'sticky header must not move when the drawer body scrolls',
        ).toBeLessThanOrEqual(1);
      });

      test('scroll-padding-top offsets focused field below sticky header (iOS soft-keyboard contract)', async ({
        page,
      }) => {
        test.skip(
          preset.width >= 640,
          'scroll-padding-top contract targets the full-screen mobile drawer.',
        );
        await openPaySheet(page);

        // Layer 1 — CSS contract: the scroll-padding-top inline style is
        // applied to the body wrapper. Assert the computed style is the
        // expected CSS var (or its 64 px fallback) so the SC 2.4.11
        // stylesheet contract is live.
        const scrollPaddingTop = await page
          .getByTestId('pay-sheet-content')
          .locator('.overflow-y-auto')
          .evaluate((el) => window.getComputedStyle(el).scrollPaddingTop);

        // Computed value is either the CSS-var resolved height or the
        // "64px" fallback literal. Either is acceptable — what we
        // forbid is `0px` / `auto` (would mean the style dropped).
        expect(
          scrollPaddingTop,
          'scrollPaddingTop must be non-zero (SC 2.4.11)',
        ).not.toMatch(/^(0px|auto)$/);
      });

      test('focused field geometry is NOT obscured by sticky header (SC 2.4.11 actual-geometry)', async ({
        page,
      }) => {
        // mobile-a11y reviewer F-01 (2026-04-24): the CSS contract test
        // above verifies the scroll-padding-top style exists but does
        // NOT prove that a focused input actually lands below the header
        // bottom. This companion test exercises focus + geometry: after
        // focus, assert `focused.top > header.bottom + 24` per plan.md
        // § WCAG 2.2 opportunistic adoption. Runs only on mobile
        // breakpoints where the sticky header is visible.
        test.skip(
          preset.width >= 640,
          'Focus-geometry contract targets the full-screen mobile drawer.',
        );
        await openPaySheet(page);

        const headerBottom = await page
          .getByTestId('pay-sheet-content')
          .locator('[data-slot="sheet-header"]')
          .evaluate((el) => el.getBoundingClientRect().bottom);

        // Focus the first interactive element inside the drawer body.
        // Stripe Elements renders inside an iframe — unavailable in
        // E2E without network; instead focus the most-likely field the
        // method-tabs render, which is the active tab trigger itself.
        // Post-Stripe-fixture lands: swap to `iframe[src*="js.stripe.com"] input`.
        const triggerId = 'pay-sheet-tab-card';
        await page.getByTestId(triggerId).focus();

        const focusedTop = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el ? el.getBoundingClientRect().top : -1;
        });

        expect(
          focusedTop,
          `focused element (testid=${triggerId}) must land below sticky header.bottom (${headerBottom}) + 24 px buffer`,
        ).toBeGreaterThan(headerBottom + 24);
      });

      test('axe-core scan: zero serious/critical violations on drawer (WCAG 2.1 AA)', async ({
        page,
      }) => {
        // mobile-a11y reviewer W-03 (2026-04-24): scope the scan to the
        // drawer subtree. The page behind the drawer carries `inert`
        // (via Radix Dialog) so axe skips it by default, but scoping
        // explicitly makes the assertion robust against Radix
        // version drift where `inert` might be absent on some nodes.
        await openPaySheet(page);

        const results = await new AxeBuilder({ page })
          .include('[data-testid="pay-sheet-content"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();

        const blocking = results.violations.filter((v) =>
          ['serious', 'critical'].includes(v.impact ?? ''),
        );
        expect(
          blocking,
          `PaySheet drawer must have zero serious/critical axe violations at ${preset.label}`,
        ).toEqual([]);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Confirmation-panel tap target (T082b).
  //
  // Strategy: `stubStripeConfirmSuccess` installs a fake `window.Stripe`
  // factory via page.addInitScript BEFORE navigation. loadStripe()
  // detects the pre-existing global + short-circuits the real bundle
  // fetch. On submit, the fake `confirmPayment` resolves to a succeeded
  // PaymentIntent, which drives PaySheetInternal: card-form → success,
  // rendering <ConfirmationPanel> and the 44×44 Download-receipt CTA.
  //
  // Must be called BEFORE `openPaySheet` so the init script is in
  // place before the page navigates.
  // -------------------------------------------------------------------------
  test.describe('confirmation panel (post-settlement)', () => {
    for (const preset of VIEWPORTS) {
      test.describe(preset.label, () => {
        test.use({
          viewport: { width: preset.width, height: preset.height },
          ...(preset.device
            ? {
                userAgent: preset.device.userAgent,
                deviceScaleFactor: preset.device.deviceScaleFactor,
                hasTouch: preset.device.hasTouch,
                isMobile: preset.device.isMobile,
              }
            : {}),
        });

        test('download-receipt CTA ≥ 44×44 px after successful settlement', async ({
          page,
        }) => {
          // Install Stripe SDK stub BEFORE navigation (addInitScript
          // runs on every page load for the lifetime of the test).
          await stubStripeConfirmSuccess(page);
          // Debug instrumentation: capture browser console + failed
          // requests so we can see if /initiate is being stubbed.
          page.on('console', (msg) => {
             
            console.log(`[browser:${msg.type()}]`, msg.text());
          });
          page.on('requestfailed', (req) => {
             
            console.log(
              '[requestfailed]',
              req.url(),
              req.failure()?.errorText,
            );
          });
          page.on('response', (res) => {
            if (res.url().includes('/api/payments/initiate')) {
               
              console.log('[initiate-response]', res.status(), res.url());
            }
          });
          await openPaySheet(page);

          // Wait for the card-form submit button to render. <CardForm>
          // gates its visible submit behind a 300 ms min-delay + the
          // Stripe element `ready` event — our stubbed element fires
          // `ready` on a microtask, so the real gate is the
          // useMinDelay floor.
          const submit = page.getByTestId('pay-sheet-card-submit');
          await expect(submit).toBeVisible({ timeout: 5_000 });
          await submit.click();

          // Assert the confirmation panel renders + the download CTA
          // meets the ≥ 44×44 tap-target contract (WCAG 2.5.5 /
          // SC 2.5.8).
          await expect(
            page.getByTestId('pay-sheet-confirmation-panel'),
          ).toBeVisible({ timeout: 5_000 });
          await expectMinTapTarget(page, 'pay-sheet-download-receipt');
        });
      });
    }
  });
});
