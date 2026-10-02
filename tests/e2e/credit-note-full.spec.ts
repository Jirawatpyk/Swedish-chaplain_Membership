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
import en from '../../src/i18n/messages/en.json';

// The confirmation field's label, built from the message file rather than
// hand-written. The copy is `Type "{phrase}" to confirm`, so the previous
// /type CREDIT/i regex could not match across the quotes and stopped finding
// the field when #230 reworded it — silently, since e2e has no CI job.
const CREDIT_NOTE_COPY = en.admin.creditNotes.new;
const CONFIRM_LABEL = CREDIT_NOTE_COPY.confirmCopy.replace(
  '{phrase}',
  CREDIT_NOTE_COPY.confirmPhrase,
);

/**
 * Tick the 088 §F.3 online-payment acknowledgement when the form shows it.
 * Conditional on purpose: the box renders only while online money is still
 * refundable, so this stays correct whether the seeded invoice is paid by card
 * or offline, instead of coupling the test to one seed state.
 */
async function acknowledgeOnlinePaidIfRequired(
  page: import('@playwright/test').Page,
): Promise<void> {
  const ack = page.getByRole('checkbox', {
    name: CREDIT_NOTE_COPY.onlinePayment.acknowledge,
  });
  if (await ack.isVisible().catch(() => false)) {
    await ack.check();
  }
}

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
    await expect(page.getByLabel(CONFIRM_LABEL)).toBeVisible();
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
    // 088 §F.3: an invoice paid online (card / PromptPay) also requires an
    // explicit acknowledgement that a credit note refunds nothing — `canSubmit`
    // is `(!requiresOnlineAck || onlineRefundAcknowledged) && …`
    // (credit-note-form.tsx:157-161). The seeded invoice is paid by card, so
    // without this the FR-040 phrase gate below can never be observed: Submit
    // would stay disabled for the OTHER reason and the test would pass its
    // `toBeDisabled` assertions for the wrong reason, then fail the last one.
    await acknowledgeOnlinePaidIfRequired(page);
    const submit = page.getByRole('button', {
      name: /^(issue credit note|ออกใบลดหนี้|utfärda kreditnota)$/i,
    });
    await expect(submit).toBeDisabled();

    // Typing a partial phrase keeps it disabled.
    await fillField(page.getByLabel(CONFIRM_LABEL), 'CRED');
    await expect(submit).toBeDisabled();

    // Typing the full phrase enables it (locale-case-insensitive so
    // 'credit' would match too, but we stick to CREDIT to match the
    // on-screen hint).
    await fillField(page.getByLabel(CONFIRM_LABEL), 'CREDIT');
    await expect(submit).toBeEnabled();
  });

  // T125 — AS1 happy path. Gated on `E2E_HAS_ADMIN_FIXTURES=1` so
  // the test only runs when the idempotent admin-side seeder has
  // provisioned a FRESH 990001-series paid invoice under the
  // "E2E Mutation Co" member. Each run mutates the fixture → paid →
  // credited; the seeder's auto-provisioning logic re-seeds a new
  // paid target on the next invocation (see
  // scripts/seed-f4-e2e-admin-fixtures.ts header comment). Re-run
  // the seeder between test sessions:
  //
  //   node --env-file=.env.local --import tsx scripts/seed-f4-e2e-admin-fixtures.ts
  //
  // Integration layer already covers the DB-state correctness
  // (credit-note-partial-accumulation.test.ts runs the same mutation
  // on a throwaway test tenant). This E2E adds the UI-glue assertion:
  // the status-badge flip on /admin/invoices/<id> after a successful
  // credit-note POST.
  // Skip gate tracked as PVR-1 in
  // `specs/007-invoices-receipts/pending-verification.md` — DB-state
  // coverage is GREEN via `credit-note-partial-accumulation.test.ts`;
  // this E2E is the UI-glue-only assertion and is NOT a ship blocker.
  // Un-fixme recipe: see PVR-1. Long-term fix: fold seeder into
  // `tests/e2e/global-setup.ts`.
  test.skip(
    process.env.E2E_HAS_ADMIN_FIXTURES !== '1',
    'E2E_HAS_ADMIN_FIXTURES=1 + seed-f4-e2e-admin-fixtures must have run — see PVR-1',
  );

  test('AS1 — full credit note flips invoice badge to Credited', async ({
    page,
  }) => {
    // Credit-note issuance includes DB tx + PDF render + blob upload +
    // audit. Widen the test envelope for dev-server first-compile.
    test.setTimeout(90_000);
    await signInAdmin(page);

    // Filter to paid + find the 995xxx credit-target row. Filter by
    // document-number prefix because the admin list renders "—" (no member
    // name) for this member, so matching on company name does not converge.
    //
    // THE FIXTURE IS SINGLE-USE. `scripts/seed-f4-e2e-admin-fixtures.ts`
    // tops up to THREE unmutated paid SC-2026-995xxx invoices under "E2E
    // Mutation Co", and this test spends one each time it runs — so one pass
    // over chromium + mobile-chrome costs two, and two consecutive runs
    // exhaust the set. A bare `waitFor` then fails with nothing but a locator
    // timeout, which reads like a selector or a DOM regression; it cost an
    // hour of bisecting a PR that had changed nothing here (R29, 2026-10-02).
    // So assert it with the reason attached.
    await page.goto('/admin/invoices?status=paid');
    await waitForLayoutContainer(page);
    const mutationRow = page
      .getByRole('row')
      .filter({ hasText: /SC-2026-995\d{3}/ });
    await expect(
      mutationRow.first(),
      'no unmutated paid SC-2026-995xxx invoice is left — the credit-target fixture is ' +
        'single-use and this test spends one per run. The page itself rendered (the layout ' +
        'container resolved above), so this is exhaustion, not a selector or a UI change. ' +
        'Top it up with: pnpm tsx --env-file=.env.local scripts/seed-f4-e2e-admin-fixtures.ts',
    ).toBeVisible({ timeout: 10_000 });
    const docLink = mutationRow.first().getByRole('link').first();
    await docLink.click();
    await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/);

    // Open credit-note form.
    await page
      .getByRole('link', { name: /issue credit note|ออกใบลดหนี้|utfärda kreditnota/i })
      .click();
    await page.waitForURL(/\/credit-notes\/new$/);
    await waitForLayoutContainer(page);

    // Full-credit: 10,700.00 THB (100% of the seeded 995xxx total,
    // which is 1_070_000n satang per seed-f4-e2e-admin-fixtures.ts:151).
    await fillField(page.getByLabel(/credit amount|จำนวนเงินลดหนี้|kreditbelopp/i), '10700.00');
    await fillField(page.getByLabel(/reason|เหตุผล|orsak/i), 'E2E AS1 full credit');
    await fillField(page.getByLabel(CONFIRM_LABEL), 'CREDIT');

    // Submit + wait for navigation back to the invoice detail page.
    const cnResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/api/credit-notes') && r.request().method() === 'POST',
      { timeout: 60_000 },
    );
    await page
      .getByRole('button', {
        name: /^(issue credit note|ออกใบลดหนี้|utfärda kreditnota)$/i,
      })
      .click();
    const resp = await cnResponse;
    if (!resp.ok()) {
      const body = await resp.text();
      throw new Error(
        `credit-note POST failed: ${resp.status()} ${body.slice(0, 500)}`,
      );
    }
    await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/, { timeout: 60_000 });

    // Status badge should read "Credited" (EN) / "เครดิตแล้ว" (TH) /
    // "Krediterad" (SV). Match any locale to avoid coupling to the
    // admin's current UI language.
    const badge = page
      .getByRole('heading', { level: 1 })
      .locator('..')
      .getByText(/^(credited|ลดหนี้แล้ว|ลดหนี้|krediterad)$/i);
    await expect(badge).toBeVisible({ timeout: 10_000 });
  });
});
