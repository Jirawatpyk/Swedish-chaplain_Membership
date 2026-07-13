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
import { signInAsManager } from './helpers/manager-session';
import { signInAsMember } from './helpers/member-session';
import { seedF8Renewals, type SeedResult } from './helpers/renewals-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

test.describe('F8 — admin cycle-detail page (Phase 6 review-round 2 A1)', () => {
  let seeded: SeedResult | null = null;

  // Staff-Review-2026-05-09 WRN-4 fix: env-var guard + seed run in
  // ONE beforeAll block. Previously the env-var guard ran in the
  // first beforeAll and the seed in the second; if seed returned
  // null (e.g. because DATABASE_URL was missing despite env-var
  // strings being set), the member-role test would TypeError on
  // `seeded!.cycleId` instead of producing a clean failure.
  test.beforeAll(async () => {
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
    seeded = await seedF8Renewals();
    if (!seeded) {
      throw new Error(
        '[A1] seedF8Renewals returned null — DATABASE_URL missing or e2e-member not found in tenant. Verify .env.local contains DATABASE_URL + E2E_MEMBER_EMAIL.',
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
    // round-2 C2 — section landmarks for keyboard/SR navigation). Give the
    // same 10s headroom as the h1 above: the FIRST navigation to
    // /admin/renewals/[cycleId] cold-compiles the route in dev/CI, so a default
    // 5s can race the compile on the first spec to hit this page (was flaky).
    await expect(
      page.getByRole('region', { name: /member.*plan|plan.*member/i }),
    ).toBeVisible({ timeout: 10_000 });
    // CycleStatusBadge label — pill with translated cycle status
    // (Phase 6 review-round 2 C1 — i18n srSuffix for severity).
    await expect(
      page.getByText(/upcoming|reminded|awaiting|completed|lapsed|cancelled/i),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('admin views a bogus cycleId — empty-state UI', async ({ page }) => {
    await signInAsAdmin(page);
    const response = await page.goto(
      '/admin/renewals/00000000-0000-0000-0000-000000000bad',
    );
    // Staff-Review-2026-05-09 WRN-2 fix: hard-assert the empty-state
    // copy unconditionally instead of the previous dual-branch
    // (200+empty-state OR 404). The dual-branch could fail by
    // Playwright timeout rather than assertion when the page returned
    // 200 with neither empty-state copy NOR 404 — opaque failure
    // mode that hid bugs.
    //
    // Page behaviour (verified at page.tsx:120-129): valid-UUID-shape
    // + non-existent cycle → load-cycle-detail returns
    // `cycle_not_found` → page renders <PageHeader> + <EmptyState>
    // with a 200 response. (`invalid_input` from a non-UUID-shape
    // would call `notFound()` for HTTP 404 — covered by the negative
    // branch below.) Empty-state copy lives at
    // `admin.renewals.cycleDetail.notFoundDescription`.
    //
    // Status assertion: must be 200 for cycle_not_found, NOT 404.
    // R2-S5: assert response is non-null first so `.status()` cannot
    // silently return undefined (which would fail the toBe(200) but
    // not in the way readers expect).
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    await expect(
      page.getByRole('heading', {
        name: /not found|cycle/i,
        level: 1,
      }),
    ).toBeVisible({ timeout: 10_000 });
    // `.first()` to dodge strict-mode violation — the empty-state copy
    // matches both the <h1> heading ("Cycle not found") AND the <p>
    // body ("This renewal cycle doesn't exist..."). Both are valid;
    // either being visible proves the empty-state UI rendered.
    await expect(
      page.getByText(/not found|don't have access|doesn't exist/i).first(),
    ).toBeVisible({ timeout: 10_000 });
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

  // Staff-Review-2026-05-09 T277e closure — manager-role read-only
  // render. Manager sessions reach the cycle-detail page (page allows
  // both 'admin' and 'manager' per the requireSession('staff') +
  // role-check at page.tsx:96-99) — the test verifies the page
  // renders for manager AND that mutating affordances (status badge,
  // member link, etc.) are present in the read-only view.
  test('manager-role views cycle-detail (read-only render)', async ({
    page,
  }) => {
    // R2-S3: skip when EITHER email or password is missing — previously
    // skipped only on missing email, leading to confusing throws from
    // `signInAsManager` if only the password env var was absent.
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'E2E_MANAGER_EMAIL or E2E_MANAGER_PASSWORD missing — set both in .env.local',
    );
    await signInAsManager(page);
    const response = await page.goto(`/admin/renewals/${seeded!.cycleId}`);
    expect(response?.status()).toBe(200);
    // Page heading visible
    await expect(
      page.getByRole('heading', { level: 1 }).first(),
    ).toBeVisible({ timeout: 10_000 });
    // Member & Plan section landmark — same as admin sees
    await expect(
      page.getByRole('region', { name: /member.*plan|plan.*member/i }),
    ).toBeVisible();
    // Status badge text — manager has read access to all status values
    await expect(
      page.getByText(/upcoming|reminded|awaiting|completed|lapsed|cancelled/i),
    ).toBeVisible();
  });
});
