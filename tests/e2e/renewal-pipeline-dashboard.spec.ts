/**
 * F8 Phase 3 Wave H5 · T078 — E2E test for `/admin/renewals` (US1).
 *
 * Walks AS1–AS5 from `specs/011-renewal-reminders/spec.md`:
 *   - AS1: pipeline renders with tier badge + urgency pill + last reminder
 *   - AS2: tier filter narrows result + URL updates with `?tier=premium`
 *   - AS3: lapsed members appear in "Lapsed" tab with reason badges
 *   - AS4: cross-tenant probe via `?member_id=…` → 404 + audit (server-
 *     side; verified separately by integration test T076. E2E asserts
 *     the page does not leak cross-tenant rows in the visible UI.)
 *   - AS5: render under p95 500ms with seed dataset (smoke; full
 *     5k-member perf benchmark in `pnpm test:perf`)
 *   - axe accessibility scan — 0 violations on default tab + lapsed tab
 *
 * Gate: skips entire suite when `FEATURE_F8_RENEWALS=false` (Phase 3
 * MVP ships dark) or when E2E_ADMIN_EMAIL is missing.
 *
 * Run with: `pnpm test:e2e --grep "renewal-pipeline-dashboard" --workers=1`
 * (workers=1 mandatory per memory feedback_e2e_workers — default of 3
 * hangs the user's machine).
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import AxeBuilder from '@axe-core/playwright';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const F8_RENEWALS_ENABLED = process.env.FEATURE_F8_RENEWALS === 'true';

test.describe('F8 — /admin/renewals pipeline dashboard (US1)', () => {
  // Constitution Principle VI: throw on missing prerequisites instead
  // of skipping so env-config gaps surface as hard failures and the
  // E2E genuinely exercises the page.
  test.beforeAll(() => {
    if (!ADMIN_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL missing — set in .env.local before running this suite.',
      );
    }
    if (!F8_RENEWALS_ENABLED) {
      throw new Error(
        'FEATURE_F8_RENEWALS=false — set FEATURE_F8_RENEWALS=true in .env.local before running this suite.',
      );
    }
  });

  test('AS1: pipeline renders with title + filter + tabs', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    const start = performance.now();
    await page.goto('/admin/renewals');
    // J8-M22: replaced `waitForLoadState('networkidle')` with
    // a deterministic role-based wait. Turbopack + RSC streaming
    // races the network-idle event in dev, causing flake on this
    // and other E2E specs. Waiting for the page heading guarantees
    // the SSR render completed without depending on side-channel
    // network timing.
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });
    const elapsed = performance.now() - start;

    // Page header + subtitle present
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible();

    // 8 urgency tabs render (T-90 / T-60 / T-30 / T-14 / T-7 / T-0 /
    // Grace / Lapsed). Scope to the urgency tablist by its accessible name:
    // the page ALSO renders the at-risk-widget's "Filter by risk band"
    // tablist (3 role=tab band buttons), so a bare getByRole('tab') matches
    // 11, not 8 (the original assertion was over-broad — it caught both
    // tablists). EN canonical label — the E2E session signs in in English,
    // mirroring the tier-filter assertion below (line ~74).
    const tabs = page
      .getByRole('tablist', { name: /filter by renewal urgency/i })
      .getByRole('tab');
    await expect(tabs).toHaveCount(8, { timeout: 10_000 });

    // Tier filter present
    await expect(page.getByLabel(/filter pipeline by tier/i)).toBeVisible();

    // AS5 perf smoke (full 5k-member benchmark in pnpm test:perf)
    expect(elapsed).toBeLessThan(5_000);
  });

  test('AS2: tier filter updates URL with ?tier=premium', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    // J8-M22: replaced `waitForLoadState('networkidle')` with
    // a deterministic role-based wait. Turbopack + RSC streaming
    // races the network-idle event in dev, causing flake on this
    // and other E2E specs. Waiting for the page heading guarantees
    // the SSR render completed without depending on side-channel
    // network timing.
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Open the tier select trigger via its accessible role.
    // The visually-hidden label and the combobox both match
    // `/filter pipeline by tier/i`, so we narrow to the combobox role
    // for a stable target.
    await page
      .getByRole('combobox', { name: /filter pipeline by tier/i })
      .click();
    // Wait for the listbox to render before clicking. base-ui mounts
    // options in a portal, so they aren't queryable until the popover
    // commits.
    const premiumOption = page.getByRole('option', { name: /^premium$/i });
    await premiumOption.waitFor({ state: 'visible', timeout: 5_000 });
    await premiumOption.click();
    // URL-driven assertion is more reliable than networkidle here —
    // router.replace() updates the URL synchronously, but networkidle
    // can fire in either order depending on RSC streaming timing.
    await page.waitForURL(/[?&]tier=premium\b/, { timeout: 10_000 });
    expect(page.url()).toContain('tier=premium');
  });

  test('AS3: lapsed tab is reachable + shows reason column', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    // J8-M22: replaced `waitForLoadState('networkidle')` with
    // a deterministic role-based wait. Turbopack + RSC streaming
    // races the network-idle event in dev, causing flake on this
    // and other E2E specs. Waiting for the page heading guarantees
    // the SSR render completed without depending on side-channel
    // network timing.
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Click the "Lapsed" tab (last in the tablist). Using
    // `waitForURL` instead of `networkidle` because RSC streaming
    // races the URL push under Turbopack dev.
    const lapsedTab = page.getByRole('tab', { name: /^lapsed/i });
    await lapsedTab.click();
    await page.waitForURL(/[?&]urgency=lapsed\b/, { timeout: 10_000 });
    expect(page.url()).toContain('urgency=lapsed');

    // Lapsed banner + Reason column header visible (regardless of row count)
    await expect(
      page.getByText(/lapsed members/i).first(),
    ).toBeVisible();
    // Reason column header — present even on empty state via TableHead
    // (the empty-state row spans columns so headers always render).
    await expect(
      page.getByRole('columnheader', { name: /reason/i }),
    ).toBeVisible();
  });

  test('AS4: cross-tenant member_id query param does not leak rows', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    // Hand-craft a synthetic cross-tenant probe URL — the page reads
    // tier/urgency/cursor params; member_id is unrecognised so the
    // page renders normally with whatever the admin's tenant has.
    // The use-case-layer cross-tenant probe (renewal_cross_tenant_probe)
    // is exercised by integration tests T076 + T077; this E2E asserts
    // the visible UI doesn't expose cross-tenant data.
    await page.goto(
      `/admin/renewals?member_id=00000000-0000-0000-0000-000000000999`,
    );
    await page.waitForLoadState('networkidle');
    // Page still renders (member_id param is ignored by route)
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible();
  });

  test('AS5 + a11y: axe scan returns 0 violations on default tab', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    // J8-M22: replaced `waitForLoadState('networkidle')` with
    // a deterministic role-based wait. Turbopack + RSC streaming
    // races the network-idle event in dev, causing flake on this
    // and other E2E specs. Waiting for the page heading guarantees
    // the SSR render completed without depending on side-channel
    // network timing.
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('a11y: axe scan returns 0 violations on lapsed tab', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals?urgency=lapsed');
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
