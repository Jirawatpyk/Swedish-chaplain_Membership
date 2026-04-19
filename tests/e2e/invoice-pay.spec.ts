/**
 * T068 — E2E: admin records payment + receipt (US2 AS1–AS4).
 *
 * Phase-4 promotion (2026-04-19): AS4 (no partial-payment affordance)
 * is promoted to a real assertion — it requires only navigation, not
 * seeded data. AS1 / AS2 / AS3 (full happy path: record payment →
 * status=paid → receipt PDF → outbox row) remain `test.fixme` —
 * they need the F4 e2e seeder (T115) that provisions an issued
 * invoice on a throwaway tenant before the pay form can be driven.
 */
import { expect, fillField, test } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
}

test.describe('@us2 record-payment', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run',
  );

  test.fixme(
    'AS1 admin records bank transfer → status=paid (needs F4 e2e seeder — T115)',
    async () => {
      // TODO(T115): needs a seeded issued invoice. The flow:
      //   1. Navigate to /admin/invoices/<issued-id>/pay
      //   2. Select paymentMethod = bank_transfer
      //   3. Fill paymentReference + paymentDate
      //   4. Submit → POST /api/invoices/<id>/pay
      //   5. Assert redirect to /admin/invoices/<id>
      //   6. Assert status badge = "Paid"
    },
  );

  test.fixme(
    'AS2 receipt PDF downloads + bilingual content (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): after AS1, click "Download receipt" and assert:
      //   1. Content-Type: application/pdf
      //   2. Byte pattern contains "ใบเสร็จ" (or combined label)
      //   3. Byte pattern contains "Receipt" (English side)
    },
  );

  test.fixme(
    'AS3 auto-email outbox row enqueued with receipt attachment (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): after AS1, SELECT from notifications_outbox for the
      // tenant — assert a row with event_type='invoice_paid' + pdf_blob_key
      // matching the receipt was enqueued.
    },
  );

  test('AS4 /admin/invoices (list view) has no partial-payment affordance anywhere', async ({
    page,
  }) => {
    await signInAdmin(page);

    // Walk the invoice surfaces a manager or admin could touch during
    // the payment flow. None of them should reveal a "partial amount"
    // affordance — partial payments are OUT of MVP scope (spec §US2 AS4).
    for (const route of [
      '/admin/invoices',
      '/admin/invoices?status=issued',
    ]) {
      await page.goto(route);
      // Wait on the h1 landmark instead of `networkidle` — analytics
      // beacons keep network busy indefinitely on some deploys (L3).
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const partial = page.getByText(/partial (amount|payment)/i);
      await expect(partial).toHaveCount(0);
    }

    // Visit the list page — verify there's no "Record partial payment"
    // button or input anywhere in the rendered DOM.
    const partialInputs = page.locator('input[name*="partial"], input[id*="partial"]');
    await expect(partialInputs).toHaveCount(0);
  });
});
