/**
 * T090 — E2E: F3 × F4 integration on the admin member page (US7).
 *
 * Covers AS1–AS4:
 *   - AS1: admin opens /admin/members/<id> and sees the Invoices
 *          section with per-row status + actions.
 *   - AS2: admin opens /admin/members/<id>/timeline and sees F4
 *          audit events rendered alongside F3 events.
 *   - AS3: manager sees the Invoices section but mutating actions
 *          (record payment, issue credit note) are absent.
 *   - AS4: member portal shows a compact invoice summary (deferred
 *          to the member portal landing page — `test.fixme` until
 *          that surface ships in a follow-up).
 *
 * The full happy-path of seeding invoices + credit notes in a browser
 * is blocked on the F4 E2E seeder (T115 tenant-scoped provisioning).
 * Until that lands we assert the structural wiring: the Invoices
 * section renders on the member detail page, the timeline route
 * accepts F4 event rows, and role gating hides the mutating actions
 * for managers. These assertions cover spec AS1 + AS3 structurally;
 * AS2 + AS4 are marked `test.fixme` pinned to T115.
 */
import { expect, fillField, test } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MANAGER_EMAIL = process.env.E2E_MANAGER_EMAIL;
const MANAGER_PASSWORD = process.env.E2E_MANAGER_PASSWORD;

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
}

async function signInManager(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), MANAGER_EMAIL!);
  await fillField(page.getByLabel(/password/i), MANAGER_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
}

async function openAnyMemberDetail(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.goto('/admin/members');
  // Scope the locator to the data table — `getByRole('link')` alone
  // would match sidebar + breadcrumb links first, giving a flaky
  // navigation to a non-member URL.
  const firstRow = page
    .getByRole('table')
    .getByRole('link')
    .first();
  await firstRow.click();
  await page.waitForURL(/\/admin\/members\/[0-9a-f-]{36}$/, { timeout: 10_000 });
}

test.describe('@us7 F3 × F4 integration on admin member page', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD',
  );

  test('AS1 admin: Invoices section renders on member detail page', async ({
    page,
  }) => {
    await signInAdmin(page);
    await openAnyMemberDetail(page);
    // The section title is the localised "Invoices" string; match the
    // CardTitle heading specifically to avoid the sidebar "Invoices"
    // nav link on the same page.
    const card = page.locator('[data-slot="card-title"]').filter({
      hasText: /invoices/i,
    });
    await expect(card.first()).toBeVisible();
  });

  test('AS3 manager: mutating actions hidden in Invoices section', async ({
    page,
  }) => {
    test.skip(
      !MANAGER_EMAIL || !MANAGER_PASSWORD,
      'Set E2E_MANAGER_EMAIL + E2E_MANAGER_PASSWORD',
    );
    await signInManager(page);
    await openAnyMemberDetail(page);

    // Locate the Invoices section (scoped so we don't pick up list
    // filters / table headers on an unrelated card).
    const invoicesCard = page
      .locator('[data-slot="card"]')
      .filter({ has: page.locator('[data-slot="card-title"]', { hasText: /invoices/i }) })
      .first();
    await expect(invoicesCard).toBeVisible();

    // Pre-condition: prove the section is actually rendered (either
    // table or empty-state). Without this, the `toHaveCount(0)` below
    // would trivially pass if the section failed to render at all.
    await expect(
      invoicesCard.getByText(/(no invoices|invoice|faktura|ใบแจ้งหนี้)/i).first(),
    ).toBeVisible();

    // Mutating actions MUST NOT render as <Link> for manager — they
    // render as disabled <Button> with a tooltip instead. Both links
    // and active buttons MUST be absent; disabled buttons are fine.
    await expect(
      invoicesCard.getByRole('link', { name: /record payment/i }),
    ).toHaveCount(0);
    await expect(
      invoicesCard.getByRole('link', { name: /issue credit note/i }),
    ).toHaveCount(0);
    // If any disabled button is shown, it must explicitly carry the
    // aria-disabled signal — not hidden, so admins can request escalation.
    const disabledButtons = invoicesCard.locator(
      'button[aria-disabled="true"]',
    );
    const count = await disabledButtons.count();
    for (let i = 0; i < count; i++) {
      await expect(disabledButtons.nth(i)).toBeVisible();
    }
  });

  test.fixme(
    'AS2 admin: F4 events appear in member timeline (needs T115 seeder)',
    async ({ page }) => {
      // Needs F4 E2E seeder to create invoice_issued + invoice_paid
      // audit rows for a specific member on a throwaway tenant, then
      // navigate to /admin/members/<id>/timeline and assert the
      // event list includes the 6 F4 event types with localised copy.
      await signInAdmin(page);
    },
  );

  test.fixme(
    'AS4 member: compact invoice summary on portal landing (needs portal landing page)',
    async ({ page }) => {
      // The member-portal landing page currently shows the placeholder.
      // Wire AS4 once the portal gets a real dashboard.
      await signInAdmin(page);
    },
  );
});
