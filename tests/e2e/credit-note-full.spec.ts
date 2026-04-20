/**
 * T082 — E2E: admin issues a FULL credit note (US6 AS1).
 *
 * Policy: mutating happy-path tests are `test.fixme` — matches the
 * peer policy in `invoice-draft-issue.spec.ts` + `invoice-pay.spec.ts`.
 * A full credit note flips the parent invoice to `credited` (terminal),
 * so re-running against the same seeded fixture would permanently
 * exhaust it. The real happy-path assertion lives in the integration
 * suite (`credit-note-partial-accumulation.test.ts`) which runs on a
 * per-test throwaway tenant.
 *
 * What IS asserted here (non-mutating smoke contracts):
 *   1. Admin signed in sees "Issue credit note" link on a paid invoice.
 *   2. Clicking the link lands on the credit-note form page.
 *   3. The form's typed-phrase gate (`CREDIT`) keeps the Submit
 *      button disabled until the phrase is typed — i.e., FR-040
 *      irreversible-action guard is wired to the button state.
 *   4. Cancel returns to the invoice detail.
 *
 * Fixture: requires `scripts/seed-e2e-portal-invoices.ts` to have
 * seeded SC-2026-900001 (paid) for the e2e-member. Gate on
 * `E2E_MEMBER_HAS_INVOICES=1` — matches existing portal specs.
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

/** Find the paid invoice SC-2026-900001 via the admin list page. */
async function openPaidSeedInvoice(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.goto('/admin/invoices?status=paid');
  await waitForLayoutContainer(page);
  const link = page
    .getByRole('link', { name: /SC-2026-900001/ })
    .first();
  await link.waitFor({ state: 'visible', timeout: 10_000 });
  await link.click();
  await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/);
}

test.describe('@us6 credit-note full-credit flow', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run',
  );
  test.skip(
    !EXPECTS_FIXTURES,
    'E2E_MEMBER_HAS_INVOICES not set — seeded paid-invoice fixture required',
  );

  test('AS0 — admin sees "Issue credit note" link on a paid invoice', async ({ page }) => {
    await signInAdmin(page);
    await openPaidSeedInvoice(page);
    const link = page.getByRole('link', { name: /issue credit note|ออกใบลดหนี้|utfärda kreditnota/i });
    await expect(link).toBeVisible();
  });

  test('AS0b — credit-note form loads with amount/reason/CREDIT confirmation', async ({
    page,
  }) => {
    await signInAdmin(page);
    await openPaidSeedInvoice(page);
    await page
      .getByRole('link', { name: /issue credit note|ออกใบลดหนี้|utfärda kreditnota/i })
      .click();
    await page.waitForURL(/\/credit-notes\/new$/);
    await waitForLayoutContainer(page);

    // All three critical fields present (amount + reason + typed confirm).
    await expect(
      page.getByLabel(/credit amount|จำนวนเงินลดหนี้|kreditbelopp/i),
    ).toBeVisible();
    await expect(page.getByLabel(/reason|เหตุผล|orsak/i)).toBeVisible();
    // Typed-phrase confirm field — the label reads "Type CREDIT to confirm…"
    await expect(page.getByLabel(/type CREDIT|พิมพ์ CREDIT|skriv CREDIT/i)).toBeVisible();
  });

  test('AS0c — Submit stays disabled until CREDIT phrase is typed (FR-040 gate)', async ({
    page,
  }) => {
    await signInAdmin(page);
    await openPaidSeedInvoice(page);
    await page
      .getByRole('link', { name: /issue credit note|ออกใบลดหนี้|utfärda kreditnota/i })
      .click();
    await page.waitForURL(/\/credit-notes\/new$/);
    await waitForLayoutContainer(page);

    // Fill amount + reason but NOT the confirm phrase.
    await fillField(page.getByLabel(/credit amount|จำนวนเงินลดหนี้|kreditbelopp/i), '100.00');
    await fillField(page.getByLabel(/reason|เหตุผล|orsak/i), 'E2E smoke test');
    const submit = page.getByRole('button', {
      name: /^(issue credit note|ออกใบลดหนี้|utfärda kreditnota)$/i,
    });
    await expect(submit).toBeDisabled();

    // Typing a partial phrase keeps it disabled.
    await fillField(page.getByLabel(/type CREDIT|พิมพ์ CREDIT|skriv CREDIT/i), 'CRED');
    await expect(submit).toBeDisabled();

    // Typing the full phrase enables it (locale-case-insensitive so
    // 'credit' would match too, but we stick to CREDIT to match the
    // on-screen hint).
    await fillField(page.getByLabel(/type CREDIT|พิมพ์ CREDIT|skriv CREDIT/i), 'CREDIT');
    await expect(submit).toBeEnabled();
  });

  test.fixme(
    'AS1 admin issues full credit note → invoice status → credited (mutating, needs teardown — T115)',
    async () => {
      // TODO(T115): needs per-test throwaway fixture. Integration suite
      // `credit-note-partial-accumulation.test.ts` covers this
      // behaviourally; this E2E would only re-verify the UI glue:
      //   1. Fill amount = full invoice total (1,070.00 THB for SC-2026-900001)
      //   2. Fill reason "E2E full credit"
      //   3. Type "CREDIT"
      //   4. Submit → POST /api/credit-notes → 201
      //   5. Wait for navigation to /admin/invoices/<id>
      //   6. Assert status badge = "Credited"
    },
  );
});
