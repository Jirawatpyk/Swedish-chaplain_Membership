/**
 * Component tests for the invoices admin table buyer column + Event chip
 * (054-event-fee-invoices Task 13).
 *
 * The "Member" column became the "Buyer" column: it now renders BOTH
 * membership invoices (linked to an F3 member) and event-fee invoices
 * (a non-member attendee with NO member row). The key invariants:
 *   - event non-member rows render the buyer name as PLAIN TEXT — never a
 *     broken `/admin/members/` link with an empty id;
 *   - membership rows keep the `/admin/members/{id}` link;
 *   - the Event chip appears ONLY on `invoiceSubject === 'event'` rows.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import {
  InvoicesTable,
  type InvoicesTableRow,
} from '@/app/(staff)/admin/invoices/_components/invoice-table';

const messages = {
  admin: {
    invoices: {
      list: {
        columns: {
          documentNumber: 'Number',
          status: 'Status',
          issueDate: 'Issued',
          dueDate: 'Due',
          total: 'Total',
          actions: 'Actions',
          buyer: 'Buyer',
          method: 'Method',
          receiptNumber: 'Receipt No.',
        },
        statuses: {
          draft: 'Draft',
          issued: 'Issued',
          paid: 'Paid',
          void: 'Void',
          credited: 'Credited',
          partially_credited: 'Partially credited',
          overdue: 'Overdue',
        },
        subjectChip: {
          event: 'Event',
          eventAria: 'Event-fee invoice',
        },
        buyerSubtitle: {
          membership: 'Membership {year}',
        },
        creditedSuffix: '+{count} CN',
        creditedTooltip: '{count} credit notes · {amount} THB credited',
        creditedAria: '{count} credit notes, {amount} credited',
        receiptNumberCombinedTooltip: 'Combined mode',
        receiptNumberCombinedAria: 'Combined mode',
        tableCaption: 'List of invoices for the selected filters.',
        actions: {
          download: 'Invoice',
          downloadReceipt: 'Receipt',
          downloadInvoiceAria: 'Download invoice {number}',
          downloadReceiptAria: 'Download receipt {number}',
          receiptPreparing: 'Receipt preparing…',
          receiptGenerating: 'Receipt generating…',
          receiptRenderFailed: 'Receipt render failed',
          receiptRenderFailedAria:
            'Receipt PDF render failed for invoice {number} — open to review',
        },
      },
      detail: {
        toast: {
          downloadInProgress: 'Downloading…',
          invoiceForbidden: 'x',
          invoiceNotFound: 'x',
          invoiceUnavailable: 'x',
          invoiceSessionExpired: 'x',
          invoiceRateLimited: 'x',
          receiptPending: 'x',
          receiptFailed: 'x',
          receiptForbidden: 'x',
          receiptUnavailable: 'x',
          receiptSessionExpired: 'x',
          receiptRateLimited: 'x',
        },
      },
      tax088: {
        billTitle: 'ใบแจ้งหนี้ / Invoice',
        badgeTaxReceipt: 'Tax receipt',
        badgeBillPayableRecord: 'Payable record — tax receipt issued',
        seeReceiptLink: 'see tax receipt {number}',
      },
    },
    paymentReconciliation: {
      methodBadge: { card: 'Card', promptpay: 'PromptPay' },
    },
  },
};

function baseRow(overrides: Partial<InvoicesTableRow>): InvoicesTableRow {
  return {
    invoiceId: 'inv-1',
    documentNumber: 'INV-2026-0001',
    status: 'issued',
    invoiceSubject: 'membership',
    buyerHasMemberLink: true,
    memberId: 'member-uuid-1',
    memberName: 'Acme Co., Ltd.',
    issueDate: '2026-06-01',
    dueDate: '2026-06-15',
    totalSatang: '100000',
    hasPdf: true,
    creditNoteCount: 0,
    creditedTotalSatang: '0',
    onlinePaymentMethod: null,
    receiptDocumentNumberRaw: null,
    hasReceiptPdf: false,
    receiptPdfStatus: null,
    buyerSubtitle: null,
    mainDownloadIsReceipt: false,
    ...overrides,
  };
}

function renderTable(rows: InvoicesTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InvoicesTable rows={rows} />
    </NextIntlClientProvider>,
  );
}

function renderTableWithLocale(rows: InvoicesTableRow[], locale: string) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <InvoicesTable rows={rows} />
    </NextIntlClientProvider>,
  );
}

describe('<InvoicesTable> buyer column', () => {
  it('renders the buyer header (renamed from "Member")', () => {
    renderTable([baseRow({})]);
    expect(
      screen.getByRole('columnheader', { name: 'Buyer' }),
    ).toBeInTheDocument();
  });

  it('renders a membership buyer as an /admin/members/ link', () => {
    renderTable([baseRow({ invoiceSubject: 'membership', buyerHasMemberLink: true })]);
    const link = screen.getByRole('link', { name: 'Acme Co., Ltd.' });
    expect(link).toHaveAttribute('href', '/admin/members/member-uuid-1');
  });

  it('renders an event non-member buyer as PLAIN TEXT — no /admin/members/ link', () => {
    renderTable([
      baseRow({
        invoiceId: 'inv-evt',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: 'Walk-in Guest Co.',
      }),
    ]);
    // The buyer name is present as text…
    const buyerText = screen.getByText('Walk-in Guest Co.');
    expect(buyerText).toBeInTheDocument();
    // …but it is NOT a link (the broken-link fix). No link anywhere in the
    // document should target /admin/members/ with an empty id.
    for (const link of screen.queryAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('/admin/members/');
    }
    // Specifically, the buyer name itself is not wrapped in an anchor.
    expect(buyerText.closest('a')).toBeNull();
  });

  it('shows the Event chip ONLY on event rows', () => {
    renderTable([
      baseRow({ invoiceId: 'inv-m', invoiceSubject: 'membership', documentNumber: 'INV-M' }),
      baseRow({
        invoiceId: 'inv-e',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: 'Guest',
        documentNumber: 'INV-E',
      }),
    ]);
    const chips = screen.getAllByText('Event');
    // Exactly one Event chip (the event row); the membership row has none.
    expect(chips).toHaveLength(1);
    const chip = chips[0]!;
    expect(chip).toHaveAttribute('aria-label', 'Event-fee invoice');
  });

  it('renders the membership-year subtitle under the buyer name', () => {
    renderTable([
      baseRow({
        invoiceSubject: 'membership',
        memberName: 'Acme Co., Ltd.',
        buyerSubtitle: 'Membership 2026',
      }),
    ]);
    // The buyer name and its muted subtitle are distinct text nodes.
    expect(screen.getByText('Acme Co., Ltd.')).toBeInTheDocument();
    expect(screen.getByText('Membership 2026')).toBeInTheDocument();
  });

  it('renders the event-name subtitle under an event buyer name', () => {
    renderTable([
      baseRow({
        invoiceId: 'inv-evt',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: 'Walk-in Guest Co.',
        buyerSubtitle: 'TSCC Gala Dinner · 2026-06-15',
      }),
    ]);
    expect(screen.getByText('Walk-in Guest Co.')).toBeInTheDocument();
    expect(
      screen.getByText('TSCC Gala Dinner · 2026-06-15'),
    ).toBeInTheDocument();
  });

  it('omits the subtitle line when buyerSubtitle is null', () => {
    renderTable([baseRow({ memberName: 'No Subtitle Co.', buyerSubtitle: null })]);
    expect(screen.getByText('No Subtitle Co.')).toBeInTheDocument();
    // No "Membership …" text leaks when the row carries no subtitle.
    expect(screen.queryByText(/^Membership /)).not.toBeInTheDocument();
  });

  it('matched-member event invoice still links (buyerHasMemberLink=true)', () => {
    // An event invoice billed to a real F3 member keeps the link even
    // though the subject is "event" — the link decision is driven by
    // buyerHasMemberLink, not the subject.
    renderTable([
      baseRow({
        invoiceId: 'inv-em',
        invoiceSubject: 'event',
        buyerHasMemberLink: true,
        memberId: 'member-uuid-2',
        memberName: 'Member Attendee Co.',
      }),
    ]);
    const link = screen.getByRole('link', { name: 'Member Attendee Co.' });
    expect(link).toHaveAttribute('href', '/admin/members/member-uuid-2');
    // …and the Event chip is still present (it tracks subject).
    expect(screen.getByText('Event')).toBeInTheDocument();
  });
});

/**
 * Receipt-No. column combined-hint gate (Round-2 /code-review C2).
 *
 * The receipt-number cell has three branches:
 *   1. `receiptDocumentNumberRaw` set       → render the raw §87 RC number
 *      (separate-mode).
 *   2. else `hasReceiptPdf && status==='paid'` → render the combined-mode
 *      hint (plain em-dash + InfoIcon, `aria-label=receiptNumberCombinedAria`)
 *      — the receipt reuses the invoice number per Thai RD §86/4 + §105ทวิ,
 *      and the receipt PDF has actually rendered (`hasReceiptPdf` is
 *      `paid && receiptPdf !== null`, page.tsx:396).
 *   3. else                                 → render a PLAIN em-dash.
 *
 * The gate at invoice-table.tsx:361 was hardened from a bare
 * `r.status === 'paid'` to `r.hasReceiptPdf && r.status === 'paid'` so a
 * paid combined-mode invoice whose receipt PDF is STILL RENDERING
 * (`hasReceiptPdf: false`, `receiptPdfStatus: 'pending'`) no longer shows
 * the "receipt = invoice number" hint prematurely. These cases pin that
 * gate; case 1 flips RED if anyone reverts to the bare status check.
 */
describe('<InvoicesTable> receipt-number combined-hint gate', () => {
  // The accessible name of the combined-mode hint span — the discriminator
  // between the combined branch (has the aria-label) and the plain-em-dash
  // branch (no aria-label). Mirrors `messages…receiptNumberCombinedAria`.
  const COMBINED_HINT_LABEL = 'Combined mode';

  it('paid + receipt mid-render (hasReceiptPdf=false) shows a PLAIN em-dash, not the combined hint', () => {
    // The mutation-sensitive case. With the hardened gate
    // (`hasReceiptPdf && status==='paid'`) this row falls into the plain
    // em-dash branch because the receipt PDF has not rendered yet. If the
    // gate is reverted to bare `r.status === 'paid'`, this paid + null-raw
    // row wrongly enters the combined branch and the hint appears — making
    // the `toBeNull()` assertion below FAIL. That is the regression guard.
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: false,
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'pending',
      }),
    ]);
    // No combined-mode hint: neither the aria-labelled span…
    expect(screen.queryByLabelText(COMBINED_HINT_LABEL)).toBeNull();
    // …nor its InfoIcon decoration is in the document.
    expect(document.querySelector('svg.lucide-info')).toBeNull();
  });

  it('paid + receipt rendered (hasReceiptPdf=true, raw=null) shows the combined-mode hint', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
      }),
    ]);
    // The aria-labelled hint span IS present…
    const hint = screen.getByLabelText(COMBINED_HINT_LABEL);
    expect(hint).toBeInTheDocument();
    // …and it carries the InfoIcon decoration (aria-hidden; the aria-label
    // on the wrapper conveys the meaning to assistive tech).
    expect(hint.querySelector('svg.lucide-info')).not.toBeNull();
    // No raw receipt number text leaks into the cell.
    expect(screen.queryByText('RC-2026-0001')).not.toBeInTheDocument();
  });

  it('separate-mode (receiptDocumentNumberRaw set) shows the raw receipt number, not the hint', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: 'RC-2026-0001',
        receiptPdfStatus: 'rendered',
      }),
    ]);
    // First branch: the raw §87 RC number is rendered verbatim.
    expect(screen.getByText('RC-2026-0001')).toBeInTheDocument();
    // …and the combined-mode hint is NOT shown (separate mode owns a
    // distinct receipt document number, so there is nothing to disambiguate).
    expect(screen.queryByLabelText(COMBINED_HINT_LABEL)).toBeNull();
  });
});

/**
 * β as-paid main-download labeling (064 remediation S7).
 *
 * A β as-paid no-TIN event row persists its MAIN pdf as the final §105
 * receipt (`pdfDocKind 'receipt_separate'`, NULL invoice document number,
 * printed number in `receiptDocumentNumberRaw`, NO separate receipt blob).
 * The list page maps `displayDocumentNumber(r)` into `documentNumber` and
 * sets `mainDownloadIsReceipt`, so the table must:
 *   - render the printed §105 number in the Number column (never '—'), and
 *   - flip the main download button to the Receipt label + receipt aria
 *     (the file the admin grabs is legally a receipt, not a tax invoice).
 */
describe('<InvoicesTable> β as-paid main download (064 remediation S7)', () => {
  it('β row: Number column shows the §105 number; main download wears the Receipt label + receipt aria', () => {
    renderTable([
      baseRow({
        status: 'paid',
        documentNumber: 'RC-2026-000777',
        receiptDocumentNumberRaw: 'RC-2026-000777',
        hasReceiptPdf: false, // β — no separate receipt blob exists
        receiptPdfStatus: 'rendered',
        mainDownloadIsReceipt: true,
      }),
    ]);
    // Number column link carries the printed §105 number (pre-fix: '—').
    expect(
      screen.getByRole('link', { name: 'RC-2026-000777' }),
    ).toHaveAttribute('href', '/admin/invoices/inv-1');

    const btn = screen.getByTestId('row-download-invoice');
    expect(btn).toHaveTextContent('Receipt');
    expect(btn).toHaveAttribute('aria-label', 'Download receipt RC-2026-000777');

    // No second receipt button (no receipt blob) and no preparing affordance
    // (receiptPdfStatus is 'rendered').
    expect(screen.queryByTestId('row-download-receipt')).toBeNull();
    expect(screen.queryByTestId('row-receipt-pending')).toBeNull();
  });

  it('default rows keep the plain Invoice label + invoice aria (byte-identical pre-064 behaviour)', () => {
    renderTable([baseRow({})]);
    const btn = screen.getByTestId('row-download-invoice');
    expect(btn).toHaveTextContent('Invoice');
    expect(btn).toHaveAttribute('aria-label', 'Download invoice INV-2026-0001');
  });
});

/**
 * 088 T066b (FR-019) — admin async receipt-PDF resilience on the invoices list.
 *
 * The action cell splits the former conflated "preparing…" affordance into two
 * DISTINCT states so a permanent render failure is never mislabelled as forever
 * in-progress (mirrors the portal S1 fix):
 *   - paid + receiptPdfStatus 'pending'  → a SHIMMER "receipt generating" state
 *     (shipped `<Skeleton>` primitive → reduced-motion-safe via skeleton-shimmer
 *     CSS) inside a role=status aria-live region.
 *   - paid + receiptPdfStatus 'failed'   → a visually-distinct inline ALERT-state
 *     affordance that LINKS to the invoice detail (actionable). It must NOT show
 *     the generating shimmer.
 *   - paid + receiptPdfStatus 'rendered' → the Receipt download (existing) with
 *     neither the shimmer nor the alert.
 */
describe('<InvoicesTable> receipt async-resilience (088 T066b)', () => {
  it('paid + pending → shimmer "receipt generating" (role=status), no failed alert', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: false,
        receiptDocumentNumberRaw: 'RC-2026-0002',
        receiptPdfStatus: 'pending',
      }),
    ]);
    const generating = screen.getByTestId('row-receipt-generating');
    expect(generating).toHaveAttribute('role', 'status');
    expect(generating).toHaveAttribute('aria-live', 'polite');
    // Uses the shipped Skeleton shimmer primitive (reduced-motion handled in CSS).
    expect(generating.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.getByText('Receipt generating…')).toBeInTheDocument();
    // NOT the terminal failed alert.
    expect(screen.queryByTestId('row-receipt-render-failed')).toBeNull();
  });

  it('paid + failed → inline alert-state row linking to detail (actionable), no shimmer', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: false,
        receiptDocumentNumberRaw: 'RC-2026-0003',
        receiptPdfStatus: 'failed',
      }),
    ]);
    const failed = screen.getByTestId('row-receipt-render-failed');
    expect(failed).toBeInTheDocument();
    // Actionable — it is a link to the invoice detail page.
    expect(failed.closest('a')).toHaveAttribute('href', '/admin/invoices/inv-1');
    expect(failed).toHaveTextContent('Receipt render failed');
    // A terminal failure must NOT reuse the in-progress shimmer.
    expect(screen.queryByTestId('row-receipt-generating')).toBeNull();
  });

  it('paid + rendered → Receipt download only (no generating shimmer, no failed alert)', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: 'RC-2026-0004',
        receiptPdfStatus: 'rendered',
      }),
    ]);
    expect(screen.getByTestId('row-download-receipt')).toBeInTheDocument();
    expect(screen.queryByTestId('row-receipt-generating')).toBeNull();
    expect(screen.queryByTestId('row-receipt-render-failed')).toBeNull();
  });

  it('failed receipt with NO invoice pdf still surfaces the alert (row does not collapse to em-dash)', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasPdf: false,
        hasReceiptPdf: false,
        receiptDocumentNumberRaw: 'RC-2026-0005',
        receiptPdfStatus: 'failed',
      }),
    ]);
    // The action cell must show the failed alert, not the '—' sentinel.
    expect(screen.getByTestId('row-receipt-render-failed')).toBeInTheDocument();
  });
});

/**
 * Date-cell formatting tests (#2 speckit-review finding).
 *
 * `invoice-table.tsx` changed from raw `{r.issueDate ?? '—'}` to
 * `formatLocalisedDate(r.issueDate, locale, { year:'numeric',
 * month:'short', day:'numeric', timeZone:'UTC' })`. These cases lock
 * the formatted output and the `null → '—'` fallback branch.
 *
 * Locale is threaded via `NextIntlClientProvider` → `useLocale()` in
 * the component — the existing harness handles this; we only need to
 * vary the `locale` prop.
 *
 * The raw ISO string `'2026-06-15'` must NOT appear verbatim in the
 * cell — that was the old (un-formatted) rendering.
 */
describe('<InvoicesTable> date cell formatting', () => {
  it('en locale: issueDate is formatted (contains year "2026" and day "15"), not raw ISO', () => {
    renderTable([baseRow({ issueDate: '2026-06-15' })]);
    // The year and day must be present as formatted text tokens.
    expect(screen.getAllByText(/2026/)[0]).toBeInTheDocument();
    expect(screen.getAllByText(/15/)[0]).toBeInTheDocument();
    // The raw ISO string must not appear verbatim (guards against regression
    // to the old `{r.issueDate ?? '—'}` path).
    expect(screen.queryByText('2026-06-15')).not.toBeInTheDocument();
  });

  it('en locale: null dueDate renders the em-dash fallback "—"', () => {
    renderTable([baseRow({ dueDate: null })]);
    // At least one "—" must be in the document (the dueDate cell).
    const dashes = screen.getAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('th locale: issueDate cell contains the BE year "2569" (2026 + 543)', () => {
    // This locks the Buddhist Era path that is the whole point of the
    // locale-aware helper. A 2026 CE date maps to 2569 BE.
    renderTableWithLocale([baseRow({ issueDate: '2026-06-15' })], 'th');
    expect(screen.getAllByText(/2569/)[0]).toBeInTheDocument();
    // Gregorian year must NOT appear as the primary year token in a
    // Thai-locale cell.
    expect(screen.queryByText('2026-06-15')).not.toBeInTheDocument();
  });
});

/**
 * 088 — tax-at-payment two-document disambiguation (T065 / T065a / T065c /
 * FR-016). page.tsx resolves each row's `taxDocumentKind` (with the flag baked
 * in) + `documentNumber` (RC for a paid bill, SC for an unpaid bill), so the
 * client table renders the SC-bill ↔ RC-§86/4-tax-receipt disambiguation from
 * those two fields alone — no env read in the client component.
 *
 *   - kind 'none' (legacy / flag off): render exactly as today.
 *   - kind 'bill'  (unpaid 088 bill): the SC number + ใบแจ้งหนี้/Invoice label.
 *   - kind 'tax_receipt' (paid 088 bill): the RC number + "Tax receipt" badge
 *     (presented first), the SC bill marked "payable record — tax receipt
 *     issued" + a clickable "see tax receipt RC-…" cross-reference.
 */
describe('<InvoicesTable> — 088 tax-at-payment disambiguation', () => {
  it('legacy row (taxDocumentKind omitted) shows NO 088 badge — byte-identical to today', () => {
    renderTable([baseRow({})]);
    expect(screen.queryByText('Tax receipt')).not.toBeInTheDocument();
    expect(screen.queryByText('ใบแจ้งหนี้ / Invoice')).not.toBeInTheDocument();
    expect(screen.queryByText(/Payable record/)).not.toBeInTheDocument();
  });

  it('UNPAID 088 bill: Number column shows the SC number + the ใบแจ้งหนี้/Invoice label; no Tax-receipt badge', () => {
    renderTable([
      baseRow({
        status: 'issued',
        documentNumber: 'SC-2026-000045',
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: null,
        taxDocumentKind: 'bill',
      }),
    ]);
    // The SC bill number is the Number-column link.
    expect(
      screen.getByRole('link', { name: 'SC-2026-000045' }),
    ).toHaveAttribute('href', '/admin/invoices/inv-1');
    // The ใบแจ้งหนี้/Invoice bill label is shown.
    expect(screen.getByText('ใบแจ้งหนี้ / Invoice')).toBeInTheDocument();
    // An unpaid bill is NOT a tax receipt.
    expect(screen.queryByText('Tax receipt')).not.toBeInTheDocument();
  });

  it('PAID 088 bill: RC number + "Tax receipt" badge presented first; SC marked payable record with a clickable "see RC" link naming its target', () => {
    renderTable([
      baseRow({
        status: 'paid',
        documentNumber: 'RC-2026-000123',
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: 'RC-2026-000123',
        taxDocumentKind: 'tax_receipt',
        hasReceiptPdf: true,
        receiptPdfStatus: 'rendered',
      }),
    ]);

    // RC is the Number-column link (the tax document, presented first).
    expect(
      screen.getByRole('link', { name: 'RC-2026-000123' }),
    ).toHaveAttribute('href', '/admin/invoices/inv-1');
    // "Tax receipt" text badge on the RC.
    expect(screen.getByText('Tax receipt')).toBeInTheDocument();
    // SC bill marked as a payable record (text label, not colour-only).
    expect(screen.getByText('SC-2026-000045')).toBeInTheDocument();
    expect(
      screen.getByText('Payable record — tax receipt issued'),
    ).toBeInTheDocument();
    // Clickable "see tax receipt RC-…" cross-reference naming its target.
    const seeRc = screen.getByRole('link', { name: 'see tax receipt RC-2026-000123' });
    expect(seeRc).toHaveAttribute('href', '/admin/invoices/inv-1');

    // T065c / FR-015 — every document control has an accessible name naming its
    // OWN document (kind + number). The MAIN download serves the SC bill PDF, so
    // it names the SC number (never the RC); the receipt download names the RC.
    const billDownload = screen.getByTestId('row-download-invoice');
    expect(billDownload).toHaveAttribute('aria-label', 'Download invoice SC-2026-000045');
    const receiptDownload = screen.getByTestId('row-download-receipt');
    expect(receiptDownload).toHaveAttribute('aria-label', 'Download receipt RC-2026-000123');
  });
});
