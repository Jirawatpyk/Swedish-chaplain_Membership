/**
 * F8 Phase 6 round-3 I2 — E2E for `/portal/renewal/[memberId]/success`.
 *
 * Pins the three observable conditional branches that the unit test
 * suite cannot reach (Server Component + DB-bound):
 *
 *   AS-success-1: activeCycle.status === 'completed' → cycle-status row VISIBLE
 *   AS-success-2: activeCycle truthy but not 'completed' (e.g.
 *                 awaiting_payment) → cycle-status row HIDDEN
 *   AS-success-3: activeCycle null → processing div + back-to-portal CTA
 *
 * Each test mutates the seed cycle then signs in as the member and
 * navigates to the success URL. testid markers (added in round-2,
 * split in R9 to disambiguate invoice vs. receipt download semantics):
 *   - receipt-download-link  — paid + receipt PDF rendered
 *   - invoice-download-link  — paid + receipt-pending, OR unpaid invoice
 *   - view-invoices-fallback — invoice fetch failed / forbidden / not-found
 *   - processing-back-to-portal — Round-3 M4 fix (no activeCycle)
 *
 * Gate: skips when FEATURE_F8_RENEWALS=false.
 */
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';
import { seedF8Renewals, type SeedResult } from './helpers/renewals-seed';
import {
  setCycleStatusForSuccessE2E,
  clearActiveCyclesForSuccessE2E,
} from './helpers/renewal-success-state';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

test.describe('F8 — portal renewal success page (Phase 6 round-3 I2)', () => {
  let seeded: SeedResult | null = null;

  test.beforeAll(async () => {
    if (!MEMBER_EMAIL) {
      throw new Error(
        'E2E_MEMBER_EMAIL missing — set in .env.local before running this suite.',
      );
    }
    if (!F8_RENEWALS_ENABLED) {
      throw new Error(
        'FEATURE_F8_RENEWALS=false — set FEATURE_F8_RENEWALS=true in .env.local before running this suite.',
      );
    }
    seeded = await seedF8Renewals();
    if (!seeded) {
      throw new Error(
        '[I2] seedF8Renewals returned null — DATABASE_URL missing or e2e-member not found.',
      );
    }
  });

  test('AS-success-1: completed cycle → cycle-status row visible + receipt link', async ({
    page,
  }) => {
    await setCycleStatusForSuccessE2E(seeded!.cycleId, 'completed');
    await signInAsMember(page);
    // Use a fake invoice query param — the page renders the testid
    // marker regardless of whether the invoice exists (the page links
    // to /portal/invoices/[id]/pdf).
    await page.goto(
      `/portal/renewal/${seeded!.memberId}/success?invoice=00000000-0000-0000-0000-000000000123`,
    );
    // Heading visible.
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Cycle-status row visible — completed status.
    await expect(
      page.getByText(/completed|สำเร็จ|slutförd/i).first(),
    ).toBeVisible({ timeout: 5_000 });
    // Receipt download link rendered (invoiceId present).
    await expect(
      page.getByTestId('receipt-download-link'),
    ).toBeVisible();
    // Processing CTA NOT rendered when activeCycle is truthy.
    await expect(
      page.getByTestId('processing-back-to-portal'),
    ).not.toBeVisible();
  });

  test('AS-success-2: non-completed active cycle → cycle-status row HIDDEN', async ({
    page,
  }) => {
    await setCycleStatusForSuccessE2E(seeded!.cycleId, 'awaiting_payment');
    await signInAsMember(page);
    await page.goto(`/portal/renewal/${seeded!.memberId}/success`);
    // Heading visible.
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // dl is rendered (newExpiry visible).
    await expect(page.getByRole('time').first()).toBeVisible();
    // Cycle-status row NOT visible (status hidden when !== 'completed').
    // Use exact text query so we don't match "completed" inside other
    // copy. Fallback: assert the cycleStatus i18n key's value is absent.
    const statusRow = page.locator('dt', {
      hasText: /^Cycle status$|^สถานะรอบ$|^Cykelstatus$/,
    });
    await expect(statusRow).toHaveCount(0);
    // No invoiceId param → fallback link rendered.
    await expect(
      page.getByTestId('view-invoices-fallback'),
    ).toBeVisible();
  });

  test('AS-success-3: no active cycle → processing message + back-to-portal CTA', async ({
    page,
  }) => {
    await clearActiveCyclesForSuccessE2E(seeded!.memberId);
    try {
      await signInAsMember(page);
      await page.goto(`/portal/renewal/${seeded!.memberId}/success`);
      // Heading still visible.
      await expect(
        page.getByRole('heading', { level: 1 }).first(),
      ).toBeVisible({ timeout: 10_000 });
      // Processing branch: aria-live region with status role + CTA.
      const live = page.locator('[role="status"][aria-live="polite"]');
      await expect(live.first()).toBeVisible();
      await expect(
        page.getByTestId('processing-back-to-portal'),
      ).toBeVisible();
    } finally {
      // R4-S6 (staff-review-2026-05-09): wrap restore in try/catch so
      // a Neon transient failure surfaces as a `console.warn` signal
      // without swallowing the original test assertion failure.
      // Tests share `seedF8Renewals` fixture state; suite-order
      // dependency exists at any worker count (CI default `1`, local
      // `3`), but the local `--workers=1` invocation override is the
      // documented reproducer mode (per `feedback_e2e_workers`
      // operator preference) — a silently-skipped restore would
      // break subsequent tests under that mode.
      try {
        await seedF8Renewals();
      } catch (restoreErr) {
        console.warn(
          '[portal-renewal-success.spec] post-test re-seed failed; downstream tests may misbehave:',
          restoreErr,
        );
      }
    }
  });
});
