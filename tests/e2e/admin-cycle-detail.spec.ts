/**
 * F8 Phase 6 review-round 2 A1 — E2E for `/admin/renewals/[cycleId]`.
 *
 * Closes the Constitution Principle II "every user story MUST have ≥1
 * acceptance test" gap on the 701-LOC cycle-detail server component
 * (the very page that prompted migration 0113 + 0114). Walks:
 *   1. Admin navigates to a real cycle → 200 + populated detail
 *   2. Admin navigates to a bogus cycleId → notFound (404)
 *   3. Member-role accesses → redirect to /portal
 *
 * Not covered (deferred to a future test wave):
 *   - Manager-role read-only render (mirrors admin view)
 *   - Cached-error regression (F7 fix verifies via type-check
 *     exhaustiveness; runtime cache test requires Vercel preview infra)
 *
 * Gate: skips when FEATURE_F8_RENEWALS=false. Reuses existing
 * `seedF8Renewals()` helper which mints an upcoming cycle.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import { signInAsMember } from './helpers/member-session';
import { seedF8Renewals, type SeedResult } from './helpers/renewals-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

test.describe('F8 — admin cycle-detail page (Phase 6 review-round 2 A1)', () => {
  let seeded: SeedResult | null = null;

  test.beforeAll(() => {
    if (!ADMIN_EMAIL || !MEMBER_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL or E2E_MEMBER_EMAIL missing — set in .env.local before running this suite.',
      );
    }
    if (!F8_RENEWALS_ENABLED) {
      throw new Error(
        'FEATURE_F8_RENEWALS=false — set FEATURE_F8_RENEWALS=true in .env.local before running this suite.',
      );
    }
  });

  test.beforeAll(async () => {
    seeded = await seedF8Renewals();
    if (!seeded) {
      throw new Error(
        '[A1] seedF8Renewals returned null — DATABASE_URL or e2e-member missing.',
      );
    }
  });

  test('admin views a real cycle — populated detail page renders', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(`/admin/renewals/${seeded!.cycleId}`);
    // Page header — title contains "Cycle detail" or company name
    // (the page sets title to either depending on hydration order).
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Member & Plan section landmark (Phase 6 review-round 1 +
    // round-2 C2 — section landmarks for keyboard/SR navigation).
    await expect(
      page.getByRole('region', { name: /member.*plan|plan.*member/i }),
    ).toBeVisible();
    // CycleStatusBadge label — pill with translated cycle status
    // (Phase 6 review-round 2 C1 — i18n srSuffix for severity).
    await expect(
      page.getByText(/upcoming|reminded|awaiting|completed|lapsed|cancelled/i),
    ).toBeVisible();
  });

  test('admin views a bogus cycleId — notFound (404)', async ({ page }) => {
    await signInAsAdmin(page);
    const response = await page.goto(
      '/admin/renewals/00000000-0000-0000-0000-000000000bad',
    );
    // notFound() in Next.js App Router returns 404 for the route.
    // The current page may render the cycle_not_found EmptyState
    // instead of the framework 404 (the use-case maps invalid_input
    // → notFound but cycle_not_found → empty-state UI).
    // Either is acceptable; we just verify the status is NOT 200 OR
    // the empty-state copy is present.
    if (response && response.status() === 200) {
      await expect(
        page.getByText(/not found|don't have access|doesn't exist/i),
      ).toBeVisible();
    } else if (response) {
      expect(response.status()).toBe(404);
    }
  });

  test('member-role is redirected away from the admin page', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto(`/admin/renewals/${seeded!.cycleId}`);
    // The page calls `redirect('/portal')` for non-admin/non-manager
    // sessions. Confirm we ended up on /portal (or /portal/*).
    await page.waitForURL(/\/portal($|\/)/, { timeout: 10_000 });
  });
});
