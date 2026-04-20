/**
 * T082 — E2E: admin issues a PARTIAL credit note (US6 AS2).
 *
 * Non-mutating assertions only (happy-path partial is covered by the
 * integration suite — see `credit-note-partial-accumulation.test.ts`).
 * This spec locks in the client-side remainder-guard UX so a
 * regression would be caught before the API returns a 409:
 *
 *   1. Typing an amount > remaining shows the "exceeds remainder"
 *      inline alert.
 *   2. While the inline alert is visible, Submit stays disabled
 *      (even if the CREDIT phrase + reason are valid).
 *
 * Gated on the seeded-fixture env flag, same as `credit-note-full`.
 */
import { expect, fillField, test } from './fixtures';
import { signInViaForm, waitForLayoutContainer } from './helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const EXPECTS_FIXTURES =
  process.env.E2E_MEMBER_HAS_INVOICES === '1' ||
  process.env.E2E_MEMBER_HAS_INVOICES === 'true';

async function signInAdmin(page: import('@playwright/test').Page): Promise<void> {
  await signInViaForm(
    page,
    '/admin/sign-in',
    ADMIN_EMAIL!,
    ADMIN_PASSWORD!,
    /^\/admin(\/|$)/,
  );
}

async function openCreditNoteFormForSeededPaidInvoice(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.goto('/admin/invoices?status=paid');
  await waitForLayoutContainer(page);
  // Use SC-2026-900002 (also paid) so AS2-partial and AS1-full tests
  // target different rows — minimises state cross-talk if both specs
  // run in the same suite.
  await page.getByRole('link', { name: /SC-2026-900002/ }).first().click();
  await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/);
  await page
    .getByRole('link', { name: /issue credit note|ออกใบลดหนี้|utfärda kreditnota/i })
    .click();
  await page.waitForURL(/\/credit-notes\/new$/);
  await waitForLayoutContainer(page);
}

test.describe('@us6 credit-note partial-credit flow', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run',
  );
  test.skip(
    !EXPECTS_FIXTURES,
    'E2E_MEMBER_HAS_INVOICES not set — seeded paid-invoice fixture required',
  );

  test('remainder display is visible on the form', async ({ page }) => {
    await signInAdmin(page);
    await openCreditNoteFormForSeededPaidInvoice(page);
    // Seeded SC-2026-900002 has total 21,400.00 THB (2_140_000 satang).
    // The form displays "Creditable remainder: 21,400.00 THB" on
    // first render because credited_total starts at 0.
    const remainder = page.getByText(
      /creditable remainder|ยอดคงเหลือที่สามารถลดหนี้ได้|återstående krediterbart/i,
    );
    await expect(remainder).toBeVisible();
  });

  test('AS2 — over-remainder amount shows inline alert + keeps Submit disabled', async ({
    page,
  }) => {
    await signInAdmin(page);
    await openCreditNoteFormForSeededPaidInvoice(page);

    // Enter an amount clearly larger than any reasonable seeded
    // invoice (999,999 THB). The form exceeds-remainder alert must
    // fire regardless of the exact seeded amount.
    await fillField(
      page.getByLabel(/credit amount|จำนวนเงินลดหนี้|kreditbelopp/i),
      '999999',
    );
    await fillField(page.getByLabel(/reason|เหตุผล|orsak/i), 'E2E over-remainder smoke');
    await fillField(page.getByLabel(/type CREDIT|พิมพ์ CREDIT|skriv CREDIT/i), 'CREDIT');

    const alert = page.getByText(
      /exceeds remainder|จำนวนเกินยอดคงเหลือ|överstiger återstoden/i,
    );
    await expect(alert).toBeVisible();

    const submit = page.getByRole('button', {
      name: /^(issue credit note|ออกใบลดหนี้|utfärda kreditnota)$/i,
    });
    await expect(submit).toBeDisabled();
  });

  test.fixme(
    'AS2 happy path: 60% partial → invoice status partially_credited (needs teardown — T115)',
    async () => {
      // TODO(T115): covered behaviourally by integration suite.
      // E2E re-verification would:
      //   1. Fill amount = 60% of seeded invoice total
      //   2. Fill reason "E2E partial"
      //   3. Type "CREDIT"
      //   4. Submit → 201 → redirect to /admin/invoices/<id>
      //   5. Assert status badge = "Partially credited"
    },
  );
});
