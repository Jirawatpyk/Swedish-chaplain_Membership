/**
 * T126 — E2E: /admin/plans list-level US4 actions (deactivate / delete /
 * undelete).
 *
 * Covers the US4 acceptance flow end-to-end:
 *   1. Row-level dropdown menu exposes Deactivate → confirm dialog →
 *      toast → badge flips to Inactive.
 *   2. Row-level dropdown menu exposes Delete → confirm dialog →
 *      row hidden from default list.
 *   3. Show-deleted toggle surfaces deleted rows again.
 *   4. Undelete on a deleted row → row reappears as Inactive (never
 *      directly Active per AS4).
 *
 * Gated on `E2E_ADMIN_EMAIL/PASSWORD` env vars so CI can skip when the
 * seeded admin account is not available. Paired with the in-session
 * browser walk that is part of /speckit.qa for Phase 6.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openSeedClient } from './helpers/open-seed-client';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const TENANT_ID = process.env.E2E_TENANT_SLUG ?? process.env.TENANT_SLUG ?? 'swecham';

/**
 * This spec's own plan, in its own year, copied from a seeded row.
 *
 * A throwaway tenant would be the usual answer (invoice-void and friends),
 * but it does not work here: `/admin/plans` calls
 * `resolveTenantFromRequest()` with NO `Request` argument
 * (admin/plans/page.tsx), and the `X-Tenant` override only applies when one
 * is passed — so the page always renders the deployed tenant no matter what
 * header the test sends. Wiring that up is product code on a
 * tenant-isolation surface, so it is not this fix's business.
 *
 * A dedicated row in a dedicated year gets the same isolation the cheap way:
 * nothing else reads 2029, so deactivating and deleting it cannot disturb
 * the seeded catalogue or the "9 plans in 2026" count the list specs assert.
 */
const PLAN_ID = 'e2e-deactivate';
const PLAN_YEAR = 2029;
const SOURCE_PLAN = { planId: 'regular', planYear: 2026 };

test.describe.configure({ mode: 'serial' });

test.describe('plans deactivate / delete / undelete — US4', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  /**
   * Seed this spec's own plan, and remove it afterwards.
   *
   * It used to drive the SEEDED `swecham` / `premium` / 2026 row and put it
   * back with a best-effort `ensurePremiumActive()`: a text probe, a click,
   * an 800 ms sleep, and no assertion that the reset took. When the reset
   * quietly failed, the row menu offered "Activate" instead of "Deactivate"
   * and the test timed out waiting for a menuitem that could not exist — and
   * it left `premium` deactivated in the shared catalogue for everything
   * else (found that way on 2026-09-30; two earlier commits, 5b980bcd1 and
   * c1931eddf, had already tried to paper over it).
   *
   * The row is copied from a seeded plan with a dynamic column list rather
   * than spelled out here, so a new NOT NULL column on `membership_plans`
   * cannot silently break this fixture.
   */
  async function removeFixturePlan(sql: ReturnType<typeof openSeedClient> extends null ? never : NonNullable<ReturnType<typeof openSeedClient>>['sql']): Promise<void> {
    await sql`
      DELETE FROM membership_plans
      WHERE tenant_id = ${TENANT_ID} AND plan_id = ${PLAN_ID} AND plan_year = ${PLAN_YEAR}
    `;
  }

  test.beforeAll(async () => {
    await clearE2ERateLimits();
    const client = openSeedClient('e2e plans-deactivate fixture');
    if (!client) return;
    try {
      await removeFixturePlan(client.sql);
      const cols = (
        await client.sql<Array<{ column_name: string }>>`
          SELECT column_name FROM information_schema.columns
          WHERE table_name = 'membership_plans' ORDER BY ordinal_position
        `
      ).map((r) => r.column_name);
      const selectList = cols
        .map((c) =>
          c === 'plan_id' ? `'${PLAN_ID}'`
          : c === 'plan_year' ? String(PLAN_YEAR)
          : c === 'is_active' ? 'TRUE'
          : c === 'deleted_at' ? 'NULL'
          : `p.${c}`,
        )
        .join(', ');
      await client.sql.unsafe(
        `INSERT INTO membership_plans (${cols.join(', ')})
         SELECT ${selectList} FROM membership_plans p
         WHERE p.tenant_id = $1 AND p.plan_id = $2 AND p.plan_year = $3`,
        [TENANT_ID, SOURCE_PLAN.planId, SOURCE_PLAN.planYear],
      );
    } finally {
      await client.end();
    }
  });

  test.afterAll(async () => {
    const client = openSeedClient('e2e plans-deactivate cleanup');
    if (!client) return;
    try {
      await removeFixturePlan(client.sql);
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

  test('full deactivate → delete → show-deleted → undelete flow', async ({ page }) => {
    await signIn(page);
    // The fixture lives in its own year, so ask for that year.
    await page.goto(`/admin/plans?year=${PLAN_YEAR}`);


    // 1. Deactivate via row-level dropdown.
    const row = page.locator(`[data-plan-id="${PLAN_ID}"]`).first();
    // Assert the precondition instead of repairing it. The menu is
    // state-dependent (plans-table.tsx): an ACTIVE plan offers Deactivate,
    // an inactive one offers Activate. If the fixture is not active, say so
    // here rather than timing out later on a menuitem that cannot exist.
    await expect(row.getByText(/^active$/i), 'fixture plan must start Active').toBeVisible();
    const actionsTrigger = row.getByRole('button', { name: /actions/i });
    await actionsTrigger.waitFor({ state: 'visible', timeout: 5_000 });
    await actionsTrigger.click();
    const deactivateItem = page.getByRole('menuitem', { name: /deactivate/i });
    await deactivateItem.waitFor({ state: 'visible', timeout: 5_000 });
    await deactivateItem.click();

    // AlertDialog confirmation — confirmCta label matches the action verb
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: /deactivate/i }).click();

    // Toast + badge flip. The toast only fires once the POST resolves, which
    // on a cold dev-server route is well past the 5 s default expect budget.
    await expect(page.getByText(/deactivated/i).first()).toBeVisible({ timeout: 15_000 });
    // Same budget as the toast: the badge only flips once `router.refresh()`
    // has round-tripped to the server and re-rendered the row.
    await expect(row.getByText(/inactive/i)).toBeVisible({ timeout: 15_000 });

    // 2. Delete (soft-delete) via row-level dropdown
    await row.getByRole('button', { name: /actions/i }).click();
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: /^delete$/i }).click();

    // Row hidden from default list
    await expect(page.locator(`[data-plan-id="${PLAN_ID}"]`)).toHaveCount(0);

    // 3. Show-deleted toggle reveals row again
    await page.getByRole('switch', { name: /show deleted/i }).click();
    await expect(page.locator(`[data-plan-id="${PLAN_ID}"]`)).toBeVisible();

    // 4. Undelete
    const deletedRow = page.locator(`[data-plan-id="${PLAN_ID}"]`).first();
    await deletedRow.getByRole('button', { name: /actions/i }).click();
    await page.getByRole('menuitem', { name: /undelete|restore/i }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('alertdialog').getByRole('button', { name: /restore/i }).click();

    // Row returns as Inactive (US4 AS4)
    await expect(deletedRow.getByText(/inactive/i)).toBeVisible({ timeout: 15_000 });
  });
});
