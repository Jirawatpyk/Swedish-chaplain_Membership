/**
 * T097 — E2E: /admin/plans/new wizard + /admin/plans/clone flow (US2).
 *
 * Covers:
 *   1. 4-step wizard (Basics → Fees → Benefits → Review) completes,
 *      submits, creates a new plan, and the new row appears in the list.
 *   2. "Clone 2026 → 2027" button invokes the clone dialog, confirms,
 *      and 9 new 2027 rows appear.
 *
 * Gated on `E2E_ADMIN_EMAIL/PASSWORD` env vars so CI can skip when the
 * seeded admin account is not available.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openSeedClient } from './helpers/open-seed-client';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const TENANT_ID = process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

/**
 * A year of its own, away from the seeded catalogue. The plan MUST NOT land
 * in the current year: these rows would then join the real 2026 catalogue
 * that the list specs and the US6 parity report count.
 */
const WIZARD_YEAR = '2027';

/** Filled by the tests, deleted in `afterAll` — see the cleanup note there. */
const createdPlanIds: string[] = [];
const clonedYears: number[] = [];

test.describe.configure({ mode: 'serial' });

test.describe('plans create + clone wizard — US2', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  /**
   * Both tests CREATE plans and nothing removed them, so every run left a
   * plan in `WIZARD_YEAR` and nine more in a fresh cloned year behind on the
   * shared dev branch (four such years were found and cleared on
   * 2026-09-30). Delete only what this run made, and only when no invoice or
   * member references it — those are the two FKs on `membership_plans`.
   */
  test.afterAll(async () => {
    const client = openSeedClient('e2e plans-create-wizard cleanup');
    if (!client) return;
    try {
      for (const planId of createdPlanIds) {
        await client.sql`
          DELETE FROM membership_plans
          WHERE tenant_id = ${TENANT_ID} AND plan_id = ${planId} AND plan_year = ${Number(WIZARD_YEAR)}
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = ${TENANT_ID} AND i.plan_id = ${planId} AND i.plan_year = ${Number(WIZARD_YEAR)})
            AND NOT EXISTS (SELECT 1 FROM members m WHERE m.tenant_id = ${TENANT_ID} AND m.plan_id = ${planId} AND m.plan_year = ${Number(WIZARD_YEAR)})
        `;
      }
      for (const year of clonedYears) {
        await client.sql`
          DELETE FROM membership_plans p
          WHERE p.tenant_id = ${TENANT_ID} AND p.plan_year = ${year}
            AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = p.tenant_id AND i.plan_id = p.plan_id AND i.plan_year = p.plan_year)
            AND NOT EXISTS (SELECT 1 FROM members m WHERE m.tenant_id = p.tenant_id AND m.plan_id = p.plan_id AND m.plan_year = p.plan_year)
        `;
      }
    } finally {
      await client.end();
    }
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); }, { timeout: 10_000 });
  }

  test('admin creates a new plan via the 4-step wizard', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans/new');

    // Step 1 — Basics
    await expect(page.getByRole('heading', { name: /basics/i })).toBeVisible();
    const planId = `e2e-${Date.now().toString(36)}`;
    // A unique NAME as well as a unique id: the name is what the list
    // assertions below match on, and a fixed one makes the second successful
    // run a strict-mode violation (precedent: de56cc5d6).
    const planName = `E2E Test Plan ${planId}`;
    createdPlanIds.push(planId);
    await page.getByLabel(/plan id/i).fill(planId);
    await page.getByLabel(/plan year/i).fill(WIZARD_YEAR);
    // 122 US6: each language's field is labelled with the language's name.
    await page.getByLabel(/^plan name \(english\)/i).fill(planName);
    // Required since #110 ("require non-empty EN description", June 2026):
    // `localeDescriptionSchema.en` carries `.min(1)`, mirroring the DB CHECK
    // `membership_plans_description_en_non_empty`, and `plan-form-errors.ts`
    // maps the field to the Basics step — so an empty one makes Next a no-op
    // and step 2 never renders. The spec had not been updated for it.
    await page.getByLabel(/^description \(english\)/i).fill('E2E test description');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 2 — Fees
    await expect(page.getByRole('heading', { name: /fees/i })).toBeVisible();
    await page.getByLabel(/annual fee/i).fill('5000');
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 3 — Benefits
    await expect(page.getByRole('heading', { name: 'Benefits', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // Step 4 — Review
    await expect(page.getByRole('heading', { name: /review/i })).toBeVisible();
    await expect(page.getByText(planName)).toBeVisible();
    await page.getByRole('button', { name: /save|create/i }).click();

    // Verify redirect + row in list. Save redirects to `/admin/plans` with no
    // year (new-plan-client.tsx), and the list then defaults to the CURRENT
    // year — so the plan we just made in WIZARD_YEAR is not in that DOM.
    // Ask for its year explicitly, as the clone test does below.
    // Wait for the REDIRECT, by exact pathname. `/\/admin\/plans/` also
    // matches `/admin/plans/new`, so it resolved the instant Save was
    // clicked — the list below then rendered before the POST had created
    // anything, and the row assertion could never pass.
    await page.waitForURL((u) => new URL(u).pathname === '/admin/plans', { timeout: 15_000 });
    await page.goto(`/admin/plans?year=${WIZARD_YEAR}`);
    await expect(page.getByText(planName)).toBeVisible();
  });

  test('admin clones 2026 → 2027 via the clone dialog', async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/plans/clone');

    // Pick a unique target year per run so re-runs don't hit
    // 409 target_year_populated. Range 2030-2099 gives plenty of room.
    const TARGET_YEAR = String(2030 + (Date.now() % 70));
    clonedYears.push(Number(TARGET_YEAR));

    await page.getByLabel(/source year/i).fill('2026');
    await page.getByLabel(/target year/i).fill(TARGET_YEAR);

    // Open confirmation dialog — use the page-level submit button,
    // not any "Clone year" nav link
    await page.getByRole('button', { name: /^clone\s+\d+\s+plans?$/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();

    // Click the confirmation button + wait for the POST in parallel
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/plans/clone') && r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page
        .getByRole('alertdialog')
        .getByRole('button', { name: /^clone\s+\d+\s+plans?$/i })
        .click(),
    ]);
    expect(response.status()).toBe(201);

    // Verify 9 new rows in the target-year filter
    await page.goto(`/admin/plans?year=${TARGET_YEAR}`);
    const rows = page.locator('tr[data-plan-id]');
    await expect(rows).toHaveCount(9, { timeout: 10_000 });
  });
});
