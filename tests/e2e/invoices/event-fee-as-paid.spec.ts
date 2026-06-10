/**
 * 064-event-invoice-paid-flow (Task 14) — event-fee AS-PAID form E2E.
 *
 * Covers the UX-review MUST-assert list for the Task 13 issuance-mode
 * selector on /admin/invoices/new (Event fee tab):
 *
 *   1. paid registration (TIN buyer) — already-paid pre-selected, payment
 *      date defaults to today (Asia/Bangkok) + method select; submit runs the
 *      TWO-STEP create-draft → issue-as-paid flow and lands on the invoice
 *      detail showing Paid; the persisted row carries the COMBINED doc kind.
 *   2. no-TIN buyer — bill-first radio `aria-disabled="true"` with the
 *      visible reason wired via `aria-describedby`; arrow keys / Space can
 *      never select it (Base UI skips disabled items).
 *   3. pending no-TIN — waiting explainer visible; the admin can still
 *      OVERRIDE to already-paid (F6 data may lag reality).
 *   4. refunded — destructive hard-block card; NO mode radio group in the
 *      DOM; submit disabled.
 *   5. reactive default — typing a 13-digit TIN on a pending non-member
 *      flips the default to bill-first (payment fields stay hidden);
 *      clearing the TIN flips back to the waiting explainer.
 *   6. @a11y — axe scan of the event-fee tab in 3 states (paid-default /
 *      pending-no-TIN / refunded): NO `duplicate-id-aria` (the Base UI
 *      labelable-fallback regression this form patched) + NO critical.
 *   7. payment-date future — inline i18n error via the noValidate manual
 *      path; the input keeps the typed ISO CE value (BE is display-only).
 *   8. two-step failure — a 500 on /issue-as-paid leaves the DRAFT (toast
 *      error + draftRemains description) and still lands on the draft
 *      detail page.
 *   9. @a11y — 320px reflow with locale sv: the as-paid form must not
 *      scroll horizontally (WCAG 2.1 1.4.4).
 *
 * Fixtures: `seedEventFeeAsPaidFixture` (helpers/event-fee-as-paid-seed.ts)
 * seeds one event + five SIMULATED non-member registrations and resets any
 * invoices a prior run created (the one-invoice-per-registration unique
 * index would otherwise 409 re-runs). All PII is fake; the 13-digit TIN
 * typed below is simulated.
 *
 * Run: pnpm test:e2e tests/e2e/invoices/event-fee-as-paid.spec.ts --workers=1
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, fillField } from '../fixtures';
import { signInAsAdmin } from '../helpers/admin-session';
import {
  AS_PAID_ATTENDEES,
  readInvoiceForRegistration,
  seedEventFeeAsPaidFixture,
  type SeedAsPaidFixtureResult,
} from '../helpers/event-fee-as-paid-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

/** SIMULATED 13-digit Thai TIN — same shape the form validates, never real. */
const FAKE_TIN = '1234512345123';

/** Today in Asia/Bangkok as YYYY-MM-DD — mirrors the form's default seed. */
function bangkokTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Deep-link to the event-fee tab pre-filled for `registrationId`, then click
 * the attendee row (the deep-link preselects the tab + event + highlights
 * the row, but the form state only binds after an explicit row select).
 */
async function openEventFeeForm(
  page: Page,
  registrationId: string,
  attendeeName: string,
): Promise<void> {
  await page.goto(`/admin/invoices/new?eventRegistrationId=${registrationId}`);
  const row = page.getByRole('button', { name: new RegExp(attendeeName) });
  // 60s budget absorbs the Turbopack cold compile of /admin/invoices/new +
  // the picker's fetch + its 300ms min-skeleton.
  await row.waitFor({ state: 'visible', timeout: 60_000 });
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
}

/** Fill the non-member buyer sub-form (legal name + address required). */
async function fillBuyer(
  page: Page,
  opts: { readonly taxId?: string } = {},
): Promise<void> {
  await fillField(page.locator('#buyer-legal-name'), 'Sim AsPaid Buyer Co Ltd');
  await fillField(page.locator('#buyer-address'), '123 Simulated Road, Bangkok 10110');
  if (opts.taxId) {
    await fillField(page.locator('#buyer-tax-id'), opts.taxId);
  }
}

test.describe('064 event-fee as-paid form modes @f4', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  let fixture: SeedAsPaidFixtureResult;

  test.beforeAll(async () => {
    const seeded = await seedEventFeeAsPaidFixture();
    test.skip(seeded === null, 'DATABASE_URL missing — cannot seed the as-paid fixture');
    fixture = seeded!;
  });

  test('paid (TIN): already-paid pre-selected + date defaults today + method select → submit issues ONE combined paid document', async ({
    page,
  }) => {
    const today = bangkokTodayIso();
    await signInAsAdmin(page);
    await openEventFeeForm(page, fixture.registrationIds.paidTin, AS_PAID_ATTENDEES.paidTin);

    // Mode pre-selected from the F6 'paid' status.
    await expect(page.locator('#issuance-mode-already-paid')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // Payment fields render with date defaulted to today (Asia/Bangkok) and
    // the method select on its default.
    await expect(page.getByTestId('as-paid-fields')).toBeVisible();
    await expect(page.locator('#payment-date')).toHaveValue(today);
    await expect(page.locator('#payment-method')).toContainText('Bank transfer');

    // TIN buyer → the preview badge shows the COMBINED doc type.
    await fillBuyer(page, { taxId: FAKE_TIN });
    await expect(page.getByTestId('doc-type-badge')).toHaveText(
      'Tax Invoice/Receipt / ใบกำกับภาษี/ใบเสร็จรับเงิน',
    );
    // Amount pre-filled from the 1,070 THB ticket → VAT-inclusive preview.
    await expect(page.getByTestId('vat-preview')).toContainText('1,070.00');

    // Submit — the as-paid label, then the success toast (PDF render + blob
    // upload happen inside the second POST, so allow a generous budget).
    await page.getByRole('button', { name: 'Record payment & issue receipt' }).click();
    await expect(
      page.locator('[data-sonner-toaster]').getByText('Payment recorded — receipt issued'),
    ).toBeVisible({ timeout: 45_000 });

    // Lands on the invoice detail: §87 document number in the h1 + Paid badge.
    await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.locator('h1')).toContainText(/[A-Z]+-\d{4}-\d{6}/);
    await expect(page.locator('h1')).toContainText('Paid');

    // Persisted row: paid + the COMBINED §86/4+§105ทวิ doc kind, payment
    // date pinned to the submitted (default-today) date.
    const row = await readInvoiceForRegistration(fixture.registrationIds.paidTin);
    expect(row, 'expected ONE non-void invoice for the paid-TIN registration').not.toBeNull();
    expect(row!.status).toBe('paid');
    expect(row!.pdfDocKind).toBe('receipt_combined');
    expect(row!.paymentDate).toBe(today);
  });

  test('no-TIN: bill-first radio aria-disabled with aria-describedby reason; arrows/Space cannot select it', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await openEventFeeForm(
      page,
      fixture.registrationIds.paidNoTin,
      AS_PAID_ATTENDEES.paidNoTin,
    );

    // No TIN typed → bill_first is disabled with the VISIBLE reason wired
    // up for SR users via aria-describedby (no hover-only tooltip).
    const billFirst = page.locator('#issuance-mode-bill-first');
    await expect(billFirst).toHaveAttribute('aria-disabled', 'true');
    await expect(billFirst).toHaveAttribute(
      'aria-describedby',
      'mode-bill-first-needs-tin',
    );
    await expect(page.getByTestId('mode-bill-first-needs-tin')).toHaveText(
      'This buyer has no tax ID — the fee must be recorded as already paid; an invoice cannot be issued before payment.',
    );

    // paid status → already_paid is the (checked) default.
    const alreadyPaid = page.locator('#issuance-mode-already-paid');
    await expect(alreadyPaid).toHaveAttribute('aria-checked', 'true');

    // Keyboard: arrow keys inside the radio group skip the disabled item;
    // Space on the focused (checked) item is a no-op. bill_first must never
    // become checked.
    await alreadyPaid.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(alreadyPaid).toHaveAttribute('aria-checked', 'true');
    await expect(billFirst).not.toHaveAttribute('aria-checked', 'true');
    // And the payment fields stayed on the as-paid path.
    await expect(page.getByTestId('as-paid-fields')).toBeVisible();
  });

  test('pending no-TIN: waiting explainer visible; explicit already-paid override reveals the payment fields', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await openEventFeeForm(page, fixture.registrationIds.pending, AS_PAID_ATTENDEES.pending);

    // No default mode: the waiting explainer (role=status) renders and no
    // payment fields show.
    const explainer = page.getByTestId('mode-waiting-explainer');
    await expect(explainer).toBeVisible();
    await expect(explainer).toContainText('wait for the money');
    await expect(page.getByTestId('as-paid-fields')).toHaveCount(0);
    await expect(page.locator('#issuance-mode-already-paid')).not.toHaveAttribute(
      'aria-checked',
      'true',
    );

    // Override — the admin attests the funds were received (F6 may lag).
    await page.locator('#issuance-mode-already-paid').click();
    await expect(page.locator('#issuance-mode-already-paid')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('as-paid-fields')).toBeVisible();
    await expect(explainer).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Record payment & issue receipt' }),
    ).toBeEnabled();
  });

  test('refunded: destructive block card, NO mode radio group in the DOM, submit disabled', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await openEventFeeForm(
      page,
      fixture.registrationIds.refunded,
      AS_PAID_ATTENDEES.refunded,
    );

    // Hard-block card (destructive Card + title + factual body).
    const blocked = page.getByTestId('mode-refunded-blocked');
    await expect(blocked).toBeVisible();
    await expect(blocked).toContainText('Registration refunded');
    await expect(blocked).toContainText(
      'This registration has been refunded — an invoice or receipt cannot be created for a refunded fee.',
    );

    // No issuance-mode radio group at all — the choice is not offerable.
    await expect(page.getByTestId('mode-selector')).toHaveCount(0);
    await expect(
      page.getByRole('radio', { name: /Already paid|Bill first/ }),
    ).toHaveCount(0);

    // Submit (the bill-first label in this null-mode state) is disabled.
    await expect(
      page.getByRole('button', { name: 'Create event-fee draft' }),
    ).toBeDisabled();
  });

  test('reactive default: typing a 13-digit TIN flips pending default to bill-first (payment fields hidden); clearing flips back', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await openEventFeeForm(page, fixture.registrationIds.pending, AS_PAID_ATTENDEES.pending);

    // Start: pending + no TIN → waiting explainer, nothing selected.
    await expect(page.getByTestId('mode-waiting-explainer')).toBeVisible();

    // Type a TIN → §2.3 default flips to bill_first WITHOUT an explicit
    // pick; payment fields stay hidden (bill_first has none).
    await fillField(page.locator('#buyer-tax-id'), FAKE_TIN);
    const billFirst = page.locator('#issuance-mode-bill-first');
    await expect(billFirst).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('as-paid-fields')).toHaveCount(0);
    await expect(page.getByTestId('mode-waiting-explainer')).toHaveCount(0);

    // Clear the TIN → flips back: explainer returns, bill_first disabled.
    await page.locator('#buyer-tax-id').fill('');
    await expect(page.getByTestId('mode-waiting-explainer')).toBeVisible();
    await expect(billFirst).toHaveAttribute('aria-disabled', 'true');
    await expect(billFirst).not.toHaveAttribute('aria-checked', 'true');
  });

  test('event-fee tab passes axe in paid-default / pending-no-TIN / refunded states — no duplicate-id-aria + no critical @a11y', async ({
    page,
  }) => {
    await signInAsAdmin(page);

    const states = [
      {
        label: 'paid-default',
        registrationId: fixture.registrationIds.paidTin,
        attendee: AS_PAID_ATTENDEES.paidTin,
        ready: () => expect(page.getByTestId('as-paid-fields')).toBeVisible(),
      },
      {
        label: 'pending-no-TIN',
        registrationId: fixture.registrationIds.pending,
        attendee: AS_PAID_ATTENDEES.pending,
        ready: () => expect(page.getByTestId('mode-waiting-explainer')).toBeVisible(),
      },
      {
        label: 'refunded',
        registrationId: fixture.registrationIds.refunded,
        attendee: AS_PAID_ATTENDEES.refunded,
        ready: () => expect(page.getByTestId('mode-refunded-blocked')).toBeVisible(),
      },
    ] as const;

    for (const state of states) {
      await openEventFeeForm(page, state.registrationId, state.attendee);
      await state.ready();

      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();

      // The Base UI labelable-fallback regression this form explicitly
      // patched (explicit aria-labelledby on every RadioGroupItem) — pin it.
      const duplicateIdAria = results.violations.filter(
        (v) => v.id === 'duplicate-id-aria',
      );
      expect(
        duplicateIdAria,
        `${state.label}: duplicate-id-aria must not regress`,
      ).toEqual([]);

      const critical = results.violations.filter((v) => v.impact === 'critical');
      expect(
        critical.map((v) => ({ id: v.id, nodes: v.nodes.length })),
        `${state.label}: no critical axe violations`,
      ).toEqual([]);
    }
  });

  test('future payment date → inline i18n error (noValidate path); input keeps the ISO CE value', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await openEventFeeForm(
      page,
      fixture.registrationIds.paidNoTin,
      AS_PAID_ATTENDEES.paidNoTin,
    );
    await fillBuyer(page); // no TIN — receipt path, never reaches submit OK

    // The input clamps max=today, but the form is noValidate — a typed
    // future date reaches the MANUAL validator which renders the i18n
    // inline error instead of a locale-fixed native bubble.
    await page.locator('#payment-date').fill('2099-01-01');
    await page.getByRole('button', { name: 'Record payment & issue receipt' }).click();

    const error = page.locator('#payment-date-error');
    await expect(error).toBeVisible();
    await expect(error).toHaveText('The payment date cannot be in the future.');
    // Value preserved as ISO CE (BE is display-only and never round-trips
    // into the input).
    await expect(page.locator('#payment-date')).toHaveValue('2099-01-01');
    // Blocked client-side: still on the create page, NO draft was created.
    expect(page.url()).toContain('/admin/invoices/new');
    expect(
      await readInvoiceForRegistration(fixture.registrationIds.paidNoTin),
      'client-side date error must block the create-draft POST entirely',
    ).toBeNull();
  });

  test('two-step failure: 500 on issue-as-paid → error toast + draftRemains description, lands on the surviving draft detail', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await openEventFeeForm(page, fixture.registrationIds.twoStep, AS_PAID_ATTENDEES.twoStep);
    await fillBuyer(page, { taxId: FAKE_TIN });

    // Intercept ONLY step 2 — the event-draft POST goes through for real,
    // so a genuine draft row exists when the issue call fails.
    await page.route('**/issue-as-paid', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'pdf_render_failed' } }),
      });
    });

    await page.getByRole('button', { name: 'Record payment & issue receipt' }).click();

    // Error toast with the mapped code copy + the draft-remains description.
    const toaster = page.locator('[data-sonner-toaster]');
    await expect(
      toaster.getByText('The PDF could not be generated — nothing was issued. Try again.'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      toaster.getByText(
        'The draft invoice was still created and remains actionable — you can retry from its detail page.',
      ),
    ).toBeVisible();

    // Still navigates to the (actionable) draft detail — not a dead end.
    await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.locator('h1')).toContainText('Draft invoice');
    await expect(page.locator('h1')).toContainText('Draft');

    // Persisted: the draft survived, nothing was numbered or issued.
    const row = await readInvoiceForRegistration(fixture.registrationIds.twoStep);
    expect(row, 'the draft must remain after the failed issue step').not.toBeNull();
    expect(row!.status).toBe('draft');
    expect(row!.documentNumber).toBeNull();
    expect(row!.pdfDocKind).toBeNull();
  });

  test('as-paid form reflows at 320px in Swedish — no horizontal scroll on the form @a11y', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    // Locale AFTER sign-in (the sign-in helper asserts EN labels).
    await page
      .context()
      .addCookies([{ name: 'NEXT_LOCALE', value: 'sv', url: 'http://localhost:3100' }]);
    // 320×800 — WCAG 2.1 1.4.4 reflow viewport (≈400% zoom of 1280).
    await page.setViewportSize({ width: 320, height: 800 });
    await openEventFeeForm(page, fixture.registrationIds.paidTin, AS_PAID_ATTENDEES.paidTin);
    await expect(page.getByTestId('as-paid-fields')).toBeVisible();

    // The as-paid FORM itself must not overflow horizontally — scoped to
    // the form element so dev-only document chrome (Next dev banner /
    // scrollbar gutter) can't false-positive the check.
    const form = page.locator('form').filter({ has: page.getByTestId('mode-selector') });
    const metrics = await form.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      metrics.scrollWidth,
      'as-paid form must not scroll horizontally at 320px (sv)',
    ).toBeLessThanOrEqual(metrics.clientWidth);

    // Document-level guard with the repo's dev-mode tolerance (Next.js dev
    // banner + scrollbar gutter add ~16px — see broadcast-a11y.spec.ts).
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThan(32);
  });
});
