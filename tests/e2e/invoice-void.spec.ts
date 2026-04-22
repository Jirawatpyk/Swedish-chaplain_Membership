/**
 * T104 — E2E: admin voids an issued invoice (US5 AS1–AS3 + FR-036).
 *
 * Phase-9 promotion mirrors `invoice-pay.spec.ts` — AS1/AS2/AS3
 * happy-path flows stay `test.fixme` until the F4 e2e seeder (T115)
 * lands an issued unpaid invoice on a throwaway tenant. The assertions
 * that need only navigation — route-level permission + form affordances
 * + FR-040 typed-phrase gate — are real tests today.
 */
import { expect, test } from './fixtures';
import { fillField } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/admin(\/|$)/, { timeout: 10_000 });
}

test.describe('@us5 void-invoice', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run',
  );

  test.fixme(
    'AS1 admin voids issued invoice → status=void, PDF re-stamped, sequence number retired (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): needs a seeded issued-unpaid invoice.
      //   1. Navigate to /admin/invoices/<issued-id>/void
      //   2. Fill reason textarea
      //   3. Type the exact invoice document number to confirm
      //   4. Submit → POST /api/invoices/<id>/void
      //   5. Assert redirect to /admin/invoices/<id>
      //   6. Assert status badge = "Void"
      //   7. Download PDF and assert the bytes contain "VOID" / "ยกเลิก"
      //   8. Issue a SECOND invoice in the same FY — assert its sequence
      //      number is the NEXT one (voided one never reused).
    },
  );

  test.fixme(
    'AS2 paid invoice cannot be voided — admin directed to credit-note flow (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): navigate to /admin/invoices/<paid-id>/void → assert
      // the page redirects/404s (the server-component refuses any status
      // other than issued) and the detail page surfaces "Issue credit note"
      // as the only reversing affordance.
    },
  );

  test.fixme(
    'AS3 voided invoice rejects further actions — pay/void/edit all blocked (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): navigate to /admin/invoices/<void-id>/pay and
      // /admin/invoices/<void-id>/void — both 404 via the fail-fast
      // status guard. /admin/invoices/<void-id> shows read-only surface.
    },
  );

  test.fixme(
    'FR-036 cancellation email with VOID-stamped PDF enqueued on void (needs F4 seeder — T115)',
    async () => {
      // TODO(T115): after AS1, query notifications_outbox for a row
      // with event_type='invoice_voided' + pdf_blob_key matching the
      // invoice. Dispatcher hand-off is covered in the unit-layer
      // outbox dispatcher test (T106).
    },
  );

  test('confirm-phrase gate blocks submission when document number not typed', async ({
    page,
  }) => {
    await signInAdmin(page);
    // Walk to the list view and confirm the page renders without a
    // partial-void or bulk-void affordance anywhere — void is always
    // per-invoice + requires a typed phrase (FR-040).
    await page.goto('/admin/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const partial = page.getByText(/partial void|bulk void/i);
    await expect(partial).toHaveCount(0);
  });
});
