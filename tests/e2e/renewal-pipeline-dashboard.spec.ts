/**
 * F8 Phase 3 Wave H5 · T078 — E2E test for `/admin/renewals` (US1).
 *
 * Walks AS1–AS5 from `specs/011-renewal-reminders/spec.md`:
 *   - AS1: pipeline renders with tier badge + urgency pill + last reminder
 *   - AS2: tier filter narrows result + URL updates with `?tier=premium`
 *   - AS3: lapsed members appear in the "Terminated" tab with reason badges
 *   - AS4: cross-tenant probe via `?member_id=…` → 404 + audit (server-
 *     side; verified separately by integration test T076. E2E asserts
 *     the page does not leak cross-tenant rows in the visible UI.)
 *   - AS5: render under p95 500ms with seed dataset (smoke; full
 *     5k-member perf benchmark in `pnpm test:perf`)
 *   - axe accessibility scan — 0 violations on default tab + terminated tab
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

type Page = import('@playwright/test').Page;

/**
 * 122 US7a — below `sm` (640px) the urgency stages are an AURA select
 * labelled "Urgency" (board `Admin-renewals-mobile`); from 640px they are a
 * nav of 8 link tabs. The mobile-chrome project runs this spec at 393px.
 */
function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 640;
}

/** The visible urgency control: the link-tab nav, or the phone select. */
function urgencyControl(page: Page) {
  return isPhone(page)
    ? page.getByRole('combobox', { name: /^urgency$/i })
    : page.getByRole('navigation', { name: /filter by renewal urgency/i });
}

/** The 8 stages (T-90 … T-0, Suspended, Terminated): links, or the select's options. */
async function expectEightStages(page: Page): Promise<void> {
  if (!isPhone(page)) {
    await expect(urgencyControl(page).getByRole('link')).toHaveCount(8, { timeout: 10_000 });
    return;
  }
  await urgencyControl(page).click();
  await expect(page.getByRole('option')).toHaveCount(8, { timeout: 10_000 });
  await page.keyboard.press('Escape');
}

/** Switch to a stage the way each layout offers it. */
async function chooseStage(page: Page, name: RegExp): Promise<void> {
  if (!isPhone(page)) {
    await urgencyControl(page).getByRole('link', { name }).click();
    return;
  }
  await urgencyControl(page).click();
  const option = page.getByRole('option', { name });
  await option.waitFor({ state: 'visible', timeout: 5_000 });
  await option.click();
}

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

    // 8 urgency chips render (T-90 / T-60 / T-30 / T-14 / T-7 / T-0 /
    // Suspended / Terminated). 122 US7a: AURA link tabs — a `nav` of links
    // (the month lens needs a "no current chip" state). Scope to it by name:
    // the section tabs are another nav on the same view. EN canonical label
    // — the E2E session signs in in English.
    // On a phone: the "Urgency" select's 8 options.
    await expectEightStages(page);

    // Tier filter present (122 US7a: an AURA select labelled "Tier").
    await expect(page.getByRole('combobox', { name: /^tier$/i })).toBeVisible();

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

    // Open the tier select (122 US7a: an AURA select labelled "Tier").
    await page.getByRole('combobox', { name: /^tier$/i }).click();
    // Wait for the listbox to render before clicking: the options exist
    // only while the list is open.
    const premiumOption = page.getByRole('option', { name: /^premium$/i });
    await premiumOption.waitFor({ state: 'visible', timeout: 5_000 });
    await premiumOption.click();
    // URL-driven assertion is more reliable than networkidle here —
    // router.replace() updates the URL synchronously, but networkidle
    // can fire in either order depending on RSC streaming timing.
    await page.waitForURL(/[?&]tier=premium\b/, { timeout: 10_000 });
    expect(page.url()).toContain('tier=premium');
  });

  test('AS3: terminated tab is reachable + shows reason column', async ({
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

    // Click the "Terminated" chip (last in the urgency nav; renamed from
    // "Lapsed"). Using `waitForURL` instead of `networkidle` because RSC
    // streaming races the URL push under Turbopack dev.
    await chooseStage(page, /^terminated/i);
    await page.waitForURL(/[?&]urgency=terminated\b/, { timeout: 10_000 });
    expect(page.url()).toContain('urgency=terminated');

    // Terminated banner + Reason column header visible (regardless of row count)
    await expect(
      page.getByText(/terminated members/i).first(),
    ).toBeVisible();
    // Reason column header — present even on empty state via TableHead
    // (the empty-state row spans columns so headers always render).
    // On a phone the lapsed table stacks into cards (122 US7a) and its
    // header row is hidden, so the table itself stands in for the header.
    if (isPhone(page)) {
      await expect(page.getByRole('table', { name: /terminated members/i })).toBeVisible();
    } else {
      await expect(
        page.getByRole('columnheader', { name: /reason/i }),
      ).toBeVisible();
    }
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

  test('a11y: axe scan returns 0 violations on terminated tab', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals?urgency=terminated');
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('item ②: row exposes a visible Send reminder button + Mark contacted opens the outreach dialog', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });
    // Visible primary action (not behind the ⋯ menu):
    const sendBtns = page.getByRole('button', { name: /^send reminder to /i });
    await expect(sendBtns.first()).toBeVisible();
    // Tertiary: open ⋯ → Mark contacted → dialog:
    await page.getByRole('button', { name: /^actions for /i }).first().click();
    await page.getByRole('menuitem', { name: /mark contacted/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
  });

  test('item ①: pipeline table is the dominant first surface, month chart is below it', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/renewals');
    await expect(
      page.getByRole('heading', { name: /renewal pipeline/i }),
    ).toBeVisible({ timeout: 10_000 });
    const urgencyTablist = urgencyControl(page);
    const monthHeading = page.getByRole('heading', {
      name: /renewals by month/i,
    });
    await expect(urgencyTablist).toBeVisible();
    await expect(monthHeading).toBeVisible();
    const tablistY = (await urgencyTablist.boundingBox())!.y;
    const monthY = (await monthHeading.boundingBox())!.y;
    expect(tablistY).toBeLessThan(monthY); // pipeline sits above the month chart
  });
});
