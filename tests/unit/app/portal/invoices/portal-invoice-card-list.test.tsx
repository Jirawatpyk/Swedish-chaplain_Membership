/**
 * 060-member-portal-d4 (I7) — render test for `<PortalInvoiceCardList>`.
 *
 * THE GAP this closes: the card list is the largest new D4 component
 * (~284 lines) yet its JSX action branches had NO non-e2e coverage — the
 * only test exercising it was the double-gated Playwright spec, which is
 * SKIPPED in CI when the portal E2E creds / seed are absent. The VM flag
 * logic is exhaustively unit-tested (tests/unit/portal/
 * invoice-row-view-model.test.ts), but nothing asserted that the CARD
 * renders exactly the action set those flags dictate — i.e. the
 * "dual-render parity" the design claims (the desktop table + this card
 * consume the SAME `vm` so they can never drift). This test is that parity
 * guard at the card's render boundary.
 *
 * RENDER STRATEGY: `<PortalInvoiceCardList>` is a SERVER component but a
 * plain SYNCHRONOUS function returning JSX (no `async`, no
 * `getTranslations`/`getLocale` hook — it takes `t` + `tStatus` as PROPS).
 * So we render it with RTL `render()` directly, passing:
 *   - `rows`: built via `toInvoiceRowViewModel(buildInvoice({...}), now)`
 *     reusing the exact `buildInvoice` fixture shape from the VM test, so
 *     the card consumes a REAL view-model (not a hand-rolled literal that
 *     could disagree with `toInvoiceRowViewModel`'s actual output).
 *   - `t` / `tStatus`: translators backed by the REAL `en.json` (the
 *     `makeRealTranslator` pattern from dashboard-loading.test.tsx) so a
 *     dangling `t('actions.foo')` surfaces as "MISSING_KEY:…" and fails
 *     the assertion instead of silently passing (the next-intl identity-
 *     mock blind spot).
 *
 * CLIENT-BUTTON MOCKS: the card renders three CLIENT components
 * (`PortalInvoiceDownloadButton`, `PortalReceiptDownloadButton`,
 * `ResendInvoiceButton`) that call `useTranslations()` / `useTransition()`
 * internally — they'd need a Next app shell + NextIntlClientProvider to
 * render for real. We mock all three with lightweight stand-ins that echo
 * the props the card passes (`label`, `aria-label`, a `data-testid`) so we
 * can assert WHICH actions the card renders WITHOUT pulling their client
 * internals into jsdom. The mocks intentionally surface the card's CHOICE
 * of label/aria (e.g. "Voided invoice" vs "Invoice", combined vs separate
 * receipt label) so the parity assertions are about the card's branching,
 * not the button internals.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Client-button mocks — echo the props the card passes so we can assert the
// card's action CHOICE without rendering the real client components.
// Mocked by their `@/`-aliased absolute path; vitest resolves the card's
// relative `./portal-pdf-download-button` / `./resend-invoice-button`
// imports to the SAME module, so these mocks intercept them.
// ---------------------------------------------------------------------------
vi.mock(
  '@/app/(member)/portal/invoices/_components/portal-pdf-download-button',
  () => ({
    PortalInvoiceDownloadButton: (props: {
      label: string;
      ariaLabel?: string;
    }) => (
      <button
        type="button"
        data-testid="invoice-download"
        aria-label={props.ariaLabel ?? props.label}
      >
        {props.label}
      </button>
    ),
    PortalReceiptDownloadButton: (props: {
      label: string;
      ariaLabel?: string;
    }) => (
      <button
        type="button"
        data-testid="receipt-download"
        aria-label={props.ariaLabel ?? props.label}
      >
        {props.label}
      </button>
    ),
  }),
);

vi.mock(
  '@/app/(member)/portal/invoices/_components/resend-invoice-button',
  () => ({
    ResendInvoiceButton: (props: { documentNumber: string }) => (
      <button
        type="button"
        data-testid="resend"
        aria-label={`resend ${props.documentNumber}`}
      >
        resend
      </button>
    ),
  }),
);

import { PortalInvoiceCardList } from '@/app/(member)/portal/invoices/_components/portal-invoice-card-list';
import { toInvoiceRowViewModel } from '@/app/(member)/portal/invoices/_utils/invoice-row-view-model';
import { asInvoiceId, type Invoice } from '@/modules/invoicing';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { asFiscalYearUnsafe } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { VatRate } from '@/modules/invoicing/domain/value-objects/vat-rate';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { makeMemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { makeTenantIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/tenant-identity-snapshot';
import en from '@/i18n/messages/en.json';

// ---------------------------------------------------------------------------
// Real-en.json translator factory (MISSING_MESSAGE defence) — identical to
// dashboard-loading.test.tsx / account-hub.test.tsx. A dangling t() ref
// renders "MISSING_KEY:<ns>.<key>" so the assertion catches it rather than
// the identity-mock silently echoing the key.
// ---------------------------------------------------------------------------
type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
      obj,
    );
}

function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, string | number>): string => {
    const nsObj = getPath(en as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
}

const t = makeRealTranslator('portal.invoices');
const tStatus = makeRealTranslator('admin.invoices.list.statuses');

// ---------------------------------------------------------------------------
// Invoice fixture builder — same shape as
// tests/unit/portal/invoice-row-view-model.test.ts, so the card consumes a
// REAL `toInvoiceRowViewModel(...)` output rather than a hand-rolled VM.
// ---------------------------------------------------------------------------
const INVOICE_UUID = '11111111-2222-4333-8444-555555555555';
// "Now" comfortably BEFORE the fixtures' dueDate (2026-04-30) so an `issued`
// invoice stays `issued` (not auto-derived to `overdue`) unless a test
// intends otherwise — keeps each state assertion about the case it names.
const NOW_BEFORE_DUE = '2026-04-10T03:00:00Z';

function sha(): Sha256Hex {
  const r = Sha256Hex.parse('a'.repeat(64));
  if (!r.ok) throw new Error('bad fixture hash');
  return r.value;
}

function docNum(): DocumentNumber {
  const r = DocumentNumber.parse('INV-2026-000001');
  if (!r.ok) throw new Error('bad fixture doc number');
  return r.value;
}

function buildInvoice(
  overrides: Partial<Extract<Invoice, { invoiceSubject: 'membership' }>> = {},
): Invoice {
  return {
    tenantId: 't',
    invoiceId: asInvoiceId(INVOICE_UUID),
    invoiceSubject: 'membership',
    memberId: 'm',
    planId: 'p',
    planYear: 2026,
    eventId: null,
    eventRegistrationId: null,
    vatInclusive: false,
    status: 'issued',
    draftByUserId: 'u',
    fiscalYear: asFiscalYearUnsafe(2026),
    sequenceNumber: 1,
    documentNumber: docNum(),
    issueDate: '2026-04-01',
    dueDate: '2026-04-30',
    paidAt: null,
    voidedAt: null,
    currency: 'THB',
    subtotal: Money.fromSatangUnsafe(100_00n),
    vatRate: VatRate.ofUnsafe('0.0700'),
    vat: Money.fromSatangUnsafe(7_00n),
    total: Money.fromSatangUnsafe(107_00n),
    creditedTotal: Money.zero(),
    proRatePolicy: null,
    netDays: 30,
    tenantIdentitySnapshot: makeTenantIdentitySnapshot({
      legal_name_th: 'x',
      legal_name_en: 'x',
      tax_id: '0',
      address_th: 'x',
      address_en: 'x',
      logo_blob_key: null,
    }),
    memberIdentitySnapshot: makeMemberIdentitySnapshot({
      legal_name: 'x',
      tax_id: null,
      address: 'x',
      primary_contact_name: 'x',
      primary_contact_email: 'contact@example.com',
    }),
    paymentMethod: null,
    paymentReference: null,
    paymentNotes: null,
    paymentRecordedByUserId: null,
    paymentDate: null,
    voidReason: null,
    voidedByUserId: null,
    autoEmailOnIssue: null,
    pdf: { blobKey: 'k', sha256: sha(), templateVersion: 1 },
    pdfDocKind: 'invoice',
    receiptPdf: null,
    receiptPdfStatus: null,
    receiptPdfRenderAttempts: 0,
    receiptPdfLastError: null,
    receiptDocumentNumberRaw: null,
    billDocumentNumberRaw: null,
    vatTreatment: 'standard',
    zeroRateCertNo: null,
    zeroRateCertDate: null,
    zeroRateCertBlobKey: null,
    lines: [],
    createdAt: '2026-04-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Render the card list for a SINGLE invoice fixture (each test asserts one
 * card's state). `now` defaults to a pre-due instant so `issued` doesn't
 * auto-flip to `overdue`.
 */
function renderCardFor(
  overrides: Partial<Extract<Invoice, { invoiceSubject: 'membership' }>> = {},
  now: string = NOW_BEFORE_DUE,
) {
  const vm = toInvoiceRowViewModel(buildInvoice(overrides), now);
  return render(
    <PortalInvoiceCardList rows={[{ vm }]} locale="en" t={t} tStatus={tStatus} />,
  );
}

/** The single rendered card's `<li>` (every test renders exactly one row). */
function theCard() {
  return screen.getByRole('listitem');
}

// ===========================================================================
// 1. issued + pdf present
// ===========================================================================
describe('<PortalInvoiceCardList> — issued + pdf present', () => {
  it('shows the Invoice download + resend, NO receipt button, with the doc-link <h2> + status badge', () => {
    renderCardFor({ status: 'issued' });

    // Invoice download present with the plain "Invoice" label (NOT voided).
    const invoice = screen.getByTestId('invoice-download');
    expect(invoice).toHaveTextContent('Invoice');
    expect(invoice).not.toHaveTextContent('Voided');

    // Resend present (issued is resendable).
    expect(screen.getByTestId('resend')).toBeInTheDocument();

    // NO receipt button (not paid).
    expect(screen.queryByTestId('receipt-download')).not.toBeInTheDocument();

    // Doc-number is a REAL <h2> heading (SR heading-tree contract).
    expect(
      screen.getByRole('heading', { level: 2, name: 'INV-2026-000001' }),
    ).toBeInTheDocument();

    // Status badge text rendered from the real statuses namespace.
    expect(theCard()).toHaveTextContent('Issued');

    // No empty-cell sentinel — there ARE actions.
    expect(theCard()).not.toHaveTextContent('—');
  });
});

// ===========================================================================
// 2. combined-paid (paid + rendered + receiptDocumentNumberRaw null)
// ===========================================================================
describe('<PortalInvoiceCardList> — combined-paid', () => {
  it('shows the combined "Tax invoice / Receipt" download, NO separate invoice anchor, and OMITS the receipt-number line', () => {
    // 064 — bill-first rows persist the receipt BLOB together with
    // 'rendered'; the fixture carries it so this stays the bill-first
    // combined shape (an as-paid row — 'rendered' + NULL blob — is the
    // separate case below).
    renderCardFor({
      status: 'paid',
      receiptDocumentNumberRaw: null,
      receiptPdfStatus: 'rendered',
      receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
    });

    // Combined-paid hides the (stale) invoice anchor → no invoice button…
    expect(screen.queryByTestId('invoice-download')).not.toBeInTheDocument();
    // …and shows ONLY the receipt button carrying the COMBINED label.
    const receipt = screen.getByTestId('receipt-download');
    expect(receipt).toHaveTextContent('Tax invoice / Receipt');
    // Combined aria preserved for SR users (the long form).
    expect(receipt).toHaveAttribute(
      'aria-label',
      'Download combined Tax Invoice / Official Receipt PDF for INV-2026-000001',
    );

    // The card OMITS the receipt-number line in combined mode (vm.receiptNumber
    // is null). Mutation-sensitive: a leaked "Receipt No." line fails here.
    expect(theCard()).not.toHaveTextContent('Receipt No.');

    // Paid badge + still resendable (paid invoice with a PDF).
    expect(theCard()).toHaveTextContent('Paid');
    expect(screen.getByTestId('resend')).toBeInTheDocument();
  });
});

// ===========================================================================
// 2b. as-paid TIN event invoice (064 — main pdf IS the final combined doc)
// ===========================================================================
describe('<PortalInvoiceCardList> — as-paid combined (main pdf is the document)', () => {
  it('shows the MAIN download with the combined label + aria; no receipt button (no receipt blob exists)', () => {
    // `applyIssueAsPaid` shape: paid + raw NULL + receiptPdfStatus
    // 'rendered' + receipt blob columns NULL + pdfDocKind
    // 'receipt_combined'. Pre-064 fix the card hid the invoice anchor AND
    // rendered a receipt button whose download 502'd (blob_missing).
    renderCardFor({
      status: 'paid',
      receiptDocumentNumberRaw: null,
      receiptPdfStatus: 'rendered',
      receiptPdf: null,
      pdfDocKind: 'receipt_combined',
    });

    // The main download survives, wearing the combined dual-role label…
    const invoice = screen.getByTestId('invoice-download');
    expect(invoice).toHaveTextContent('Tax invoice / Receipt');
    expect(invoice).toHaveAttribute(
      'aria-label',
      'Download combined Tax Invoice / Official Receipt PDF for INV-2026-000001',
    );
    // …and no receipt button points at the non-existent receipt blob.
    expect(screen.queryByTestId('receipt-download')).not.toBeInTheDocument();
    // No spinner/failed affordances either — the document is right there.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(theCard()).not.toHaveTextContent('Receipt unavailable');
  });
});

// ===========================================================================
// 2c. β as-paid no-TIN event invoice (064 remediation S3 — main pdf IS the
//     §105 receipt; invoice-stream docnum legitimately NULL)
// ===========================================================================
describe('<PortalInvoiceCardList> — β as-paid receipt (main pdf is the §105 receipt)', () => {
  it('h2 shows the printed §105 number (never the UUID); main download wears the Receipt label + receipt aria', () => {
    // `applyIssueAsPaid` β shape: paid + documentNumber NULL +
    // receiptDocumentNumberRaw set + receiptPdfStatus 'rendered' + receipt
    // blob NULL + pdfDocKind 'receipt_separate'. Pre-fix the card heading
    // fell back to the raw invoice UUID and the main download wore the
    // plain "Invoice" label on a document that is legally a receipt.
    renderCardFor({
      status: 'paid',
      documentNumber: null,
      receiptDocumentNumberRaw: 'RCP-2026-000777',
      receiptPdfStatus: 'rendered',
      receiptPdf: null,
      pdfDocKind: 'receipt_separate',
    });

    // The printed §105 number is the card heading — NOT the row UUID.
    expect(
      screen.getByRole('heading', { level: 2, name: 'RCP-2026-000777' }),
    ).toBeInTheDocument();
    expect(theCard()).not.toHaveTextContent(INVOICE_UUID);

    // Main download: short Receipt label + the receipt aria carrying the
    // §105 number (never the combined dual-role wording — that stays
    // TIN-combined only).
    const invoice = screen.getByTestId('invoice-download');
    expect(invoice).toHaveTextContent('Receipt');
    expect(invoice).not.toHaveTextContent('Tax invoice / Receipt');
    expect(invoice).toHaveAttribute(
      'aria-label',
      'Download tax receipt PDF for invoice RCP-2026-000777',
    );

    // No broken receipt button (no receipt blob exists) and no async
    // affordances ('rendered').
    expect(screen.queryByTestId('receipt-download')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // The separate-mode receipt-number line still renders.
    expect(theCard()).toHaveTextContent('Receipt No.');
    expect(theCard()).toHaveTextContent('RCP-2026-000777');
  });
});

// ===========================================================================
// 3. separate-paid (paid + receiptDocumentNumberRaw set + rendered)
// ===========================================================================
describe('<PortalInvoiceCardList> — separate-paid', () => {
  it('shows BOTH Invoice + Receipt buttons (short labels) AND the receipt-number line', () => {
    renderCardFor({
      status: 'paid',
      receiptDocumentNumberRaw: 'RCP-2026-000009',
      receiptPdfStatus: 'rendered',
      receiptPdf: { blobKey: 'rk', sha256: sha(), templateVersion: 1 },
    });

    // Both downloads present; the receipt uses the SHORT separate label.
    expect(screen.getByTestId('invoice-download')).toHaveTextContent('Invoice');
    const receipt = screen.getByTestId('receipt-download');
    expect(receipt).toHaveTextContent('Receipt');
    expect(receipt).not.toHaveTextContent('Tax invoice / Receipt');

    // Receipt-number line shown in separate mode with the raw number.
    const card = theCard();
    expect(card).toHaveTextContent('Receipt No.');
    expect(card).toHaveTextContent('RCP-2026-000009');
  });
});

// ===========================================================================
// 4. receipt-pending (paid + receiptPdfStatus 'pending')
// ===========================================================================
describe('<PortalInvoiceCardList> — receipt-pending', () => {
  it('shows the aria-busy "Receipt preparing…" live region and NO terminal failed text', () => {
    renderCardFor({ status: 'paid', receiptPdfStatus: 'pending' });

    // The live region: role=status + aria-busy + the preparing label.
    const live = screen.getByRole('status');
    expect(live).toHaveAttribute('aria-busy', 'true');
    expect(live).toHaveTextContent('Receipt preparing…');

    // NOT the terminal failed copy (mutation guard vs case 5).
    expect(theCard()).not.toHaveTextContent('Receipt unavailable');
    // Pending state offers no receipt download yet.
    expect(screen.queryByTestId('receipt-download')).not.toBeInTheDocument();
  });
});

// ===========================================================================
// 5. receipt-failed (paid + receiptPdfStatus 'failed') — S1 / U4 affordance
// ===========================================================================
describe('<PortalInvoiceCardList> — receipt-failed (terminal)', () => {
  it('shows the static "Receipt unavailable" text with NO aria-busy / role=status / "preparing"', () => {
    renderCardFor({ status: 'paid', receiptPdfStatus: 'failed' });

    const card = theCard();
    // The terminal affordance text.
    expect(card).toHaveTextContent('Receipt unavailable');

    // MUTATION-SENSITIVE (the crux of S1): a terminal failure must NOT be
    // rendered as the perpetual pending spinner. So NONE of the pending
    // signals may appear.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(
      document.querySelector('[aria-busy="true"]'),
    ).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent('Receipt preparing…');

    // A failed-receipt paid invoice still has its issue-time PDF → invoice
    // download + resend remain (rowHasAnyAction true, not the '—' sentinel).
    expect(screen.getByTestId('invoice-download')).toBeInTheDocument();
    expect(card).not.toHaveTextContent('—');
  });
});

// ===========================================================================
// 6. void + pdf
// ===========================================================================
describe('<PortalInvoiceCardList> — void + pdf', () => {
  it('uses the void-aware download label "Voided invoice" and HIDES resend', () => {
    renderCardFor({ status: 'void' });

    // Void-aware label on the invoice download.
    const invoice = screen.getByTestId('invoice-download');
    expect(invoice).toHaveTextContent('Voided invoice');
    expect(invoice).toHaveAttribute(
      'aria-label',
      'Download voided invoice PDF (VOID-stamped) for INV-2026-000001',
    );

    // Resend HIDDEN (void is not resendable). Mutation-sensitive: dropping
    // the `vm.resendable ?` guard would render the resend stub here.
    expect(screen.queryByTestId('resend')).not.toBeInTheDocument();

    // Void badge.
    expect(theCard()).toHaveTextContent('Void');
  });
});

// ===========================================================================
// 7. no-action (issued + pdf null + receiptPdfStatus null → sentinel)
// ===========================================================================
describe('<PortalInvoiceCardList> — no-action row (sentinel)', () => {
  it('renders the em-dash EmptyCell sentinel and NO action buttons / no empty action div', () => {
    renderCardFor({ status: 'issued', pdf: null, receiptPdfStatus: null });

    const card = theCard();
    // The decorative em-dash sentinel (aria-hidden) is present…
    expect(card).toHaveTextContent('—');

    // …and NONE of the four interactive actions render.
    expect(screen.queryByTestId('invoice-download')).not.toBeInTheDocument();
    expect(screen.queryByTestId('receipt-download')).not.toBeInTheDocument();
    expect(screen.queryByTestId('resend')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // Mutation-sensitive: the sentinel is a <span> (EmptyCell), not the
    // `flex flex-wrap` action group. Assert the action group's wrapper
    // (which would hold the buttons) is absent — there is no flex-wrap div.
    expect(card.querySelector('.flex-wrap')).toBeNull();
  });
});

// ===========================================================================
// List / a11y structure — role=list <ul> + per-<li> aria-label
// ===========================================================================
describe('<PortalInvoiceCardList> — list structure + per-item aria-label', () => {
  it('renders a role=list <ul> whose <li> carries aria-label "Invoice {docNumber}, {status}"', () => {
    const vmIssued = toInvoiceRowViewModel(
      buildInvoice({ status: 'issued' }),
      NOW_BEFORE_DUE,
    );
    render(
      <PortalInvoiceCardList
        rows={[{ vm: vmIssued }]}
        locale="en"
        t={t}
        tStatus={tStatus}
      />,
    );

    // Root is a role=list (it IS a <ul>, but assert the explicit role too).
    const list = screen.getByRole('list');
    expect(list.tagName).toBe('UL');

    // The <li> carries the SR at-a-glance summary: singular "Invoice"
    // (detail.title) + doc number + localised status.
    const item = within(list).getByRole('listitem');
    expect(item).toHaveAttribute('aria-label', 'Invoice INV-2026-000001, Issued');
  });

  it('renders one <li> per row when given multiple rows', () => {
    // Distinct invoiceIds so the two rows get unique React keys (the fixture
    // builder otherwise reuses one UUID) — avoids a duplicate-key warning and
    // keeps the two <li> genuinely distinct.
    const a = {
      ...toInvoiceRowViewModel(buildInvoice({ status: 'issued' }), NOW_BEFORE_DUE),
      invoiceId: asInvoiceId('aaaaaaaa-2222-4333-8444-555555555555'),
    };
    const b = {
      ...toInvoiceRowViewModel(
        buildInvoice({ status: 'paid', receiptPdfStatus: 'rendered' }),
        NOW_BEFORE_DUE,
      ),
      invoiceId: asInvoiceId('bbbbbbbb-2222-4333-8444-555555555555'),
    };
    render(
      <PortalInvoiceCardList
        rows={[{ vm: a }, { vm: b }]}
        locale="en"
        t={t}
        tStatus={tStatus}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
