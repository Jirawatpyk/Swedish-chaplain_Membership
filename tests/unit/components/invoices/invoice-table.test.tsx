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
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

// 107-auto-invoice Task 14 — `<AutoRenewalQueueActions>` (rendered inside
// the Actions cell for a draft queue row) calls `useRouter()` from
// `next/navigation`, which throws outside an App Router context. No
// existing test in this file exercises `canManageQueueActions`/
// `canRecordPayment`, so this mock is additive and does not affect any
// pre-existing assertion.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import {
  InvoicesTable,
  type InvoicesTableRow,
} from '@/app/(staff)/admin/invoices/_components/invoice-table';

const messages = {
  admin: {
    invoices: {
      list: {
        columns: {
          documentNumber: 'Invoice No.',
          status: 'Status',
          issueDate: 'Issued',
          dueDate: 'Due',
          total: 'Total',
          totalPending: 'Not calculated until issued',
          actions: 'Actions',
          buyer: 'Buyer',
          method: 'Method',
          receiptNumber: 'Receipt No.',
          queue: 'Queue',
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
        creditNoteCount: '{count, plural, one {# credit note} other {# credit notes}}',
        issuedOn: 'Issued {date}',
        draftNumberLabel: 'Draft',
        tableCaption: 'List of invoices for the selected filters.',
        queueTableCaption: 'List of auto-renewal drafts awaiting review.',
        queue: {
          wouldBeRefused: 'Would be refused',
          wouldBeRefusedAria: 'Would be refused',
          refusalReason: {
            planYearDrift: 'The renewal period changed after this draft was created.',
            memberTerminated: "This member's coverage has lapsed.",
            duplicateLiveBill: 'A bill for this member and plan year already exists.',
          },
          viewConflictingInvoice: 'View existing bill',
          unresolved: 'Unable to verify',
          unresolvedAria: 'Unable to verify this draft',
          unresolvedTooltip: 'Could not verify.',
          priceUnverifiable: 'Price could not be confirmed',
          priceUnverifiableAria: 'Price could not be confirmed',
          priceFrozenOnly: 'Frozen at {frozen}',
          priceChanged: 'Price changed',
          priceChangedAria: 'Price changed — frozen at {frozen}, current is {current}',
          billYearStale: 'Fiscal year has changed since drafting',
          billYearStaleAria: 'Fiscal year has changed; today is {currentFiscalYear}',
          billYearStaleTooltip:
            'Drafted for fiscal year {planYear}; today is fiscal year {currentFiscalYear}.',
          staleness:
            '{days, plural, =0 {Drafted today} one {Drafted # day ago} other {Drafted # days ago}}',
        },
        actions: {
          download: 'Invoice',
          downloadReceipt: 'Receipt',
          downloadInvoiceAria: 'Download invoice {number}',
          downloadReceiptAria: 'Download receipt {number}',
          downloadBill: 'Bill label',
          downloadBillAria: 'Download bill {number}',
          receiptPreparing: 'Receipt preparing…',
          receiptGenerating: 'Receipt generating…',
          receiptRenderFailed: 'Receipt render failed',
          receiptRenderFailedAria:
            'Receipt PDF render failed for invoice {number} — open to review',
          openDraftAria: 'Open draft invoice for {name}',
          moreAria: 'More actions for {number}',
          view: 'View invoice',
          recordPayment: 'Record payment…',
          recordPaymentAria: 'Record payment for invoice {number}',
        },
      },
      autoRenewalQueue: {
        actions: {
          menuAria: "Actions for {member}'s renewal draft",
          issueAndSend: 'Issue and email',
          issueSilently: 'Issue silently',
          discard: 'Discard draft',
          cancel: 'Cancel',
          sendDialog: {
            title: 'Issue and email this bill?',
            description: 'A membership bill will be issued for {member}.',
          },
          silentDialog: {
            title: 'Issue this bill without emailing?',
            description: 'A membership bill will be issued for {member}.',
          },
          discardDialog: {
            title: 'Discard this draft?',
            description: 'This draft bill for {member} will be permanently deleted.',
          },
          toast: {
            issuedAndSent: 'Bill {number} issued and emailed.',
            issuedSilently: 'Bill {number} issued.',
            discarded: 'Draft discarded.',
          },
          errors: {
            draftNotFound: 'Draft not found.',
            invalidDraft: 'Invalid draft.',
            discardNotDraft: 'Already issued.',
            issueFailed: 'Could not issue.',
            discardFailed: 'Could not discard.',
            network: 'Network error.',
          },
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
      // 088 A-refined — the ONLY tax088 label the list still renders is the
      // Receipt-No link's accessible name. The per-row ใบแจ้งหนี้/ใบกำกับภาษี tags
      // were dropped (the SC-/RC- prefixes + the renamed column headers are
      // self-documenting).
      tax088: {
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

/** Opens a row's ⋯ menu (spec 122 US8 T802: the downloads live there). */
function openRowMenu(number: string) {
  fireEvent.click(screen.getByRole('button', { name: `More actions for ${number}` }));
  return screen.getByRole('menu');
}

function renderTableWithLocale(rows: InvoicesTableRow[], locale: string) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <InvoicesTable rows={rows} />
    </NextIntlClientProvider>,
  );
}

// draft-number-label — renders against the REAL, shipped en.json (not the
// hand-picked `messages` stub above) so these tests catch a missing/typo'd
// key at test time rather than a silent MISSING_MESSAGE at runtime.
function renderTableRealMessages(rows: InvoicesTableRow[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <InvoicesTable rows={rows} />
    </NextIntlClientProvider>,
  );
}

function renderQueueTable(
  rows: InvoicesTableRow[],
  showQueueMetaColumn: boolean,
  canManageQueueActions = false,
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InvoicesTable
        rows={rows}
        showQueueMetaColumn={showQueueMetaColumn}
        canManageQueueActions={canManageQueueActions}
      />
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

  // renewals-suspended-visibility-audit Task 4 — long legal names used to
  // ride TableCell's base `whitespace-nowrap` and stretch the whole table
  // into a horizontal scrollbar. The real prod offenders drive the cases.
  it('clamps a long buyer name to 2 lines with a bounded width, keeping the full name in title (Task 4)', () => {
    const LONG =
      'TOYOTA MATERIAL HANDLING WAREHOUSE SOLUTIONS (THAILAND) CO., LTD.';
    renderTable([
      baseRow({ invoiceSubject: 'membership', buyerHasMemberLink: true, memberName: LONG }),
    ]);
    const link = screen.getByRole('link', { name: LONG });
    // 2-line clamp + bounded width so the name grows DOWN, never across
    // (members-directory company-cell convention + line-clamp).
    expect(link.className).toContain('line-clamp-2');
    expect(link.className).toContain('max-w-[32ch]');
    expect(link.className).toContain('break-words');
    // Full name stays reachable when visually clamped.
    expect(link).toHaveAttribute('title', LONG);
    // The rows grow to fit wrapped content (AURA rowHeight="auto") — without
    // it the clamp can never wrap and the cell ends in an ellipsis.
    expect(link.closest('[role="gridcell"]')).toHaveClass('aura-table__td--auto');
  });

  it('clamps a long NON-member buyer name the same way (plain-text span)', () => {
    const LONG = 'THE BINARY HOLDINGS (THAILAND) COMPANY LIMITED';
    renderTable([
      baseRow({
        invoiceId: 'inv-evt-long',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: LONG,
      }),
    ]);
    const span = screen.getByText(LONG);
    expect(span.closest('a')).toBeNull();
    expect(span.className).toContain('line-clamp-2');
    expect(span.className).toContain('max-w-[32ch]');
    expect(span).toHaveAttribute('title', LONG);
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

  it('clamps the subtitle to 2 lines with the full text in title (A3 — same treatment as the name)', () => {
    const LONG_SUBTITLE =
      'Annual General Meeting & Networking Gala Dinner at the Athenee Hotel · 2026-06-15';
    renderTable([
      baseRow({
        invoiceId: 'inv-evt-sub',
        invoiceSubject: 'event',
        buyerHasMemberLink: false,
        memberId: '',
        memberName: 'Walk-in Guest Co.',
        buyerSubtitle: LONG_SUBTITLE,
      }),
    ]);
    const subtitle = screen.getByText(LONG_SUBTITLE);
    expect(subtitle.className).toContain('line-clamp-2');
    expect(subtitle.className).toContain('max-w-[32ch]');
    expect(subtitle).toHaveAttribute('title', LONG_SUBTITLE);
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
 * Receipt-No. column: the raw RC number when the row has one, else a plain
 * em-dash. The pre-088 combined-mode hint (em-dash + InfoIcon for a paid row
 * with no RC whose receipt reused the invoice number) is retired — prod has no
 * such rows and the 088 flag is permanently on.
 */
describe('<InvoicesTable> receipt-number column', () => {
  it('a paid row with no RC number shows a plain em-dash (no combined-mode hint)', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: null,
        receiptPdfStatus: 'rendered',
      }),
    ]);
    expect(document.querySelector('svg.lucide-info')).toBeNull();
  });

  it('a row with an RC number shows it verbatim', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: 'RC-2026-0001',
        receiptPdfStatus: 'rendered',
      }),
    ]);
    expect(screen.getByText('RC-2026-0001')).toBeInTheDocument();
  });
});

/**
 * 092 — §86/4 receipt stays available after a §86/10 credit note (admin table).
 *
 * The serialiser (page.tsx) now computes `hasReceiptPdf` as
 * `invoiceStatusHasReceipt(status) && receiptPdf !== null`, so a credited /
 * partially_credited invoice with a rendered receipt blob arrives with
 * `hasReceiptPdf: true`. The client trusts that flag: the receipt download
 * keys off `hasReceiptPdf`, NOT a raw `status === 'paid'` re-check (dropped in
 * 092).
 * Thai VAT §86/10: a credit note reduces the sale but does not cancel the
 * receipt, so admin staff must keep downloading it (e.g. to re-send).
 */
describe('<InvoicesTable> — receipt stays downloadable after a credit note (092)', () => {
  it('credited separate-mode (hasReceiptPdf=true, RC set) → receipt download shown AND bill download shown', () => {
    renderTable([
      baseRow({
        status: 'credited',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: 'RC-2026-0009',
        receiptPdfStatus: 'rendered',
      }),
    ]);
    const menu = openRowMenu('INV-2026-0001');
    expect(within(menu).getByRole('menuitem', { name: 'Download receipt RC-2026-0009' })).toBeInTheDocument();
    // Separate-mode → the bill/tax-invoice PDF is a distinct doc, still shown.
    expect(within(menu).getByRole('menuitem', { name: 'Download invoice INV-2026-0001' })).toBeInTheDocument();
  });

  it('partially_credited separate-mode → receipt download shown', () => {
    renderTable([
      baseRow({
        status: 'partially_credited',
        hasReceiptPdf: true,
        receiptDocumentNumberRaw: 'RC-2026-0010',
        receiptPdfStatus: 'rendered',
      }),
    ]);
    const menu = openRowMenu('INV-2026-0001');
    expect(within(menu).getByRole('menuitem', { name: 'Download receipt RC-2026-0010' })).toBeInTheDocument();
  });

  it('void row (hasReceiptPdf=false from serialiser) → NO receipt download (void keeps its own path)', () => {
    // The serialiser excludes void from `invoiceStatusHasReceipt`, so a void row
    // arrives with hasReceiptPdf=false; the client shows no receipt affordance.
    renderTable([
      baseRow({ status: 'void', hasReceiptPdf: false, receiptDocumentNumberRaw: null }),
    ]);
    const menu = openRowMenu('INV-2026-0001');
    expect(within(menu).queryByRole('menuitem', { name: /Download receipt/ })).toBeNull();
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

    const menu = openRowMenu('RC-2026-000777');
    const downloads = within(menu).getAllByRole('menuitem', { name: /^Download/ });
    // The main pdf IS the §105 receipt: one item, named as a receipt; no second
    // receipt item (no receipt blob) and no preparing affordance ('rendered').
    expect(downloads.map((d) => d.textContent)).toEqual(['Download receipt RC-2026-000777']);
    expect(screen.queryByTestId('row-receipt-generating')).toBeNull();
  });

  it('088 SC- bill rows wear the bill label + aria, never the tax-invoice one', () => {
    renderTable([
      baseRow({ documentNumber: 'SC-2026-000045', mainDownloadIsBill: true }),
    ]);
    const menu = openRowMenu('SC-2026-000045');
    expect(within(menu).getByRole('menuitem', { name: 'Download bill SC-2026-000045' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Download invoice/ })).toBeNull();
  });

  it('default rows keep the plain Invoice label + invoice aria (byte-identical pre-064 behaviour)', () => {
    renderTable([baseRow({})]);
    const menu = openRowMenu('INV-2026-0001');
    expect(within(menu).getByRole('menuitem', { name: 'Download invoice INV-2026-0001' })).toBeInTheDocument();
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
  it('paid + pending → a busy "receipt generating" line under the receipt number, no failed alert', () => {
    renderTable([
      baseRow({
        status: 'paid',
        hasReceiptPdf: false,
        receiptDocumentNumberRaw: 'RC-2026-0002',
        receiptPdfStatus: 'pending',
      }),
    ]);
    const generating = screen.getByTestId('row-receipt-generating');
    // A busy placeholder, not a live region (US7c UX rule), under the RC number.
    expect(generating).toHaveAttribute('aria-busy', 'true');
    expect(generating).not.toHaveAttribute('role', 'status');
    expect(generating).toHaveTextContent('Receipt generating…');
    expect(generating.closest('[role="gridcell"]')).toHaveTextContent('RC-2026-0002');
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
    const menu = openRowMenu('INV-2026-0001');
    expect(within(menu).getByRole('menuitem', { name: 'Download receipt RC-2026-0004' })).toBeInTheDocument();
    expect(screen.queryByTestId('row-receipt-generating')).toBeNull();
    expect(screen.queryByTestId('row-receipt-render-failed')).toBeNull();
  });

  // The retired pre-088 combined-mode rule no longer hides a paid row's main
  // PDF (prod has no such rows; the 088 flag is permanently on): whatever the
  // receipt's state, a row with a PDF keeps its Invoice download.
  it.each(['pending', 'failed'] as const)(
    'paid row with no RC + receipt %s → the Invoice download stays next to the receipt state',
    (receiptPdfStatus) => {
      renderTable([
        baseRow({
          status: 'paid',
          hasPdf: true,
          hasReceiptPdf: false,
          receiptDocumentNumberRaw: null,
          receiptPdfStatus,
        }),
      ]);
      expect(
        within(openRowMenu('INV-2026-0001')).getByRole('menuitem', { name: 'Download invoice INV-2026-0001' }),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId(
          receiptPdfStatus === 'pending' ? 'row-receipt-generating' : 'row-receipt-render-failed',
        ),
      ).toBeInTheDocument();
    },
  );

  it('paid 088 bill + pending RC → the SC bill download stays (088 FR-015)', () => {
    renderTable([
      baseRow({
        status: 'paid',
        documentNumber: 'SC-2026-000045',
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: 'RC-2026-000123',
        taxDocumentKind: 'tax_receipt',
        mainDownloadIsBill: true,
        hasPdf: true,
        hasReceiptPdf: false,
        receiptPdfStatus: 'pending',
      }),
    ]);
    expect(screen.getByTestId('row-receipt-generating')).toBeInTheDocument();
    expect(
      within(openRowMenu('SC-2026-000045')).getByRole('menuitem', { name: 'Download bill SC-2026-000045' }),
    ).toBeInTheDocument();
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
 * 088 A-refined — tax-at-payment two-document disambiguation (FR-016). page.tsx
 * resolves each row's `taxDocumentKind` (with the flag baked in) + `documentNumber`
 * (the invoice's OWN SC bill number for a real 088 bill, paid OR unpaid), so the
 * client table renders the A-refined SC-bill ↔ RC-§86/4-tax-receipt separation
 * from those fields alone — no env read in the client component.
 *
 * A-refined (product-owner ratified): the invoice is ALWAYS identified by its OWN
 * (SC) number in the Number column; the RC §86/4 tax receipt is a clickable link
 * in the Receipt No. column when paid. NO per-row ใบแจ้งหนี้/ใบกำกับภาษี tags — the
 * SC-/RC- prefixes + the renamed column headers ("Invoice No." / "Receipt No.")
 * are self-documenting.
 *
 *   - kind 'none' (legacy / flag off): render exactly as today.
 *   - kind 'bill'  (unpaid 088 bill): the SC number in the Number column; the
 *     Receipt No. column is an em-dash (no RC yet).
 *   - kind 'tax_receipt' (paid 088 bill): the SC number in the Number column; the
 *     RC is a clickable link (→ invoice detail) in the Receipt No. column.
 */
describe('<InvoicesTable> — 088 tax-at-payment disambiguation (A-refined)', () => {
  it('legacy row (taxDocumentKind omitted) shows NO 088 tag/label — byte-identical to today', () => {
    renderTable([baseRow({})]);
    expect(screen.queryByText('Tax receipt')).not.toBeInTheDocument();
    expect(screen.queryByText('ใบแจ้งหนี้ / Invoice')).not.toBeInTheDocument();
    expect(screen.queryByText(/Payable record/)).not.toBeInTheDocument();
    // The legacy §87 invoice number stays the plain (non-underlined) Number link.
    expect(
      screen.getByRole('link', { name: 'INV-2026-0001' }),
    ).toHaveAttribute('href', '/admin/invoices/inv-1');
  });

  it('UNPAID 088 bill: Number column is the SC number; NO per-row tag; Receipt No. is an em-dash (no RC yet)', () => {
    renderTable([
      baseRow({
        status: 'issued',
        documentNumber: 'SC-2026-000045',
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: null,
        taxDocumentKind: 'bill',
      }),
    ]);
    // The SC bill number IS the Number-column link (the row identity).
    expect(
      screen.getByRole('link', { name: 'SC-2026-000045' }),
    ).toHaveAttribute('href', '/admin/invoices/inv-1');
    // A-refined — no per-row document-kind tags anywhere.
    expect(screen.queryByText('ใบแจ้งหนี้ / Invoice')).not.toBeInTheDocument();
    expect(screen.queryByText('Tax receipt')).not.toBeInTheDocument();
    // No RC yet → no receipt link.
    expect(
      screen.queryByRole('link', { name: /see tax receipt/ }),
    ).not.toBeInTheDocument();
  });

  it('PAID 088 bill: Number column is the SC number; Receipt No. column is the RC as a clickable link (→ detail) with a naming aria-label; NO per-row tags', () => {
    renderTable([
      baseRow({
        status: 'paid',
        documentNumber: 'SC-2026-000045',
        billDocumentNumberRaw: 'SC-2026-000045',
        receiptDocumentNumberRaw: 'RC-2026-000123',
        taxDocumentKind: 'tax_receipt',
        hasReceiptPdf: true,
        receiptPdfStatus: 'rendered',
      }),
    ]);

    // A-refined — the Number column is the invoice's OWN (SC) number, NOT the RC.
    expect(
      screen.getByRole('link', { name: 'SC-2026-000045' }),
    ).toHaveAttribute('href', '/admin/invoices/inv-1');

    // The RC lives in the Receipt No. column as a CLICKABLE link → the invoice
    // detail (fix for "Receipt No. can't be clicked"). Its accessible name comes
    // from `seeReceiptLink` so the two same-target links in the row are
    // distinguishable to screen readers.
    const receiptLink = screen.getByRole('link', {
      name: 'see tax receipt RC-2026-000123',
    });
    expect(receiptLink).toHaveAttribute('href', '/admin/invoices/inv-1');
    // …and its VISIBLE text is the RC number (WCAG 2.5.3 Label in Name).
    expect(receiptLink).toHaveTextContent('RC-2026-000123');

    // A-refined — NO per-row document-kind tags / payable-record sub-line.
    expect(screen.queryByText('Tax receipt')).not.toBeInTheDocument();
    expect(screen.queryByText(/Payable record/)).not.toBeInTheDocument();

    // FR-015 — every document control names its OWN document. The MAIN download
    // serves the SC bill PDF (names the SC); the receipt download names the RC.
    const menu = openRowMenu('SC-2026-000045');
    expect(within(menu).getByRole('menuitem', { name: 'Download invoice SC-2026-000045' })).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Download receipt RC-2026-000123' })).toBeInTheDocument();
  });
});

/**
 * 107-auto-invoice Task 13 — auto-renewal review-queue column.
 *
 * `showQueueMetaColumn` gates a whole extra column so the STANDARD list
 * view (the default, `showQueueMetaColumn` unset) is byte-identical to
 * before this task — no header, no cell, regardless of whether a row
 * happens to carry `queueMeta`. When the column IS shown, a `null`
 * `queueMeta` (any row outside the queue's own origin filter) renders a
 * plain em-dash rather than crashing or silently omitting the cell.
 */
describe('<InvoicesTable> — auto-renewal review-queue column (107-auto-invoice Task 13)', () => {
  it('showQueueMetaColumn unset (default) → NO "Queue" column header, even if a row carries queueMeta', () => {
    renderTable([
      baseRow({
        queueMeta: {
          unresolved: false,
          stalenessDays: 2,
          frozenPriceDisplay: '50,000.00 THB',
          currentCataloguePriceDisplay: '60,000.00 THB',
          priceChanged: true,
          priceUnverifiable: false,
          planYear: 2025,
          currentFiscalYear: 2026,
          billYearStale: false,
          refusalReason: null,
        },
      }),
    ]);
    expect(screen.queryByRole('columnheader', { name: 'Queue' })).toBeNull();
    expect(screen.queryByTestId('queue-price-changed')).toBeNull();
    // A8 — the default view keeps the generic table caption, not the queue one.
    expect(
      screen.getByRole('grid', { name: 'List of invoices for the selected filters.' }),
    ).toBeInTheDocument();
  });

  it('showQueueMetaColumn=true + queueMeta=null → renders the column with a plain em-dash, and swaps the table caption (review A8)', () => {
    renderQueueTable([baseRow({ queueMeta: null })], true);
    expect(screen.getByRole('columnheader', { name: 'Queue' })).toBeInTheDocument();
    const cell = screen.getByTestId('queue-meta-cell');
    expect(cell).toHaveTextContent('—');
    expect(
      screen.getByRole('grid', {
        name: 'List of auto-renewal drafts awaiting review.',
      }),
    ).toBeInTheDocument();
  });

  it('showQueueMetaColumn=true + queueMeta present → renders the badges inside the table (would-be-refused distinct state)', () => {
    renderQueueTable(
      [
        baseRow({
          invoiceId: 'inv-queue-1',
          documentNumber: '—',
          status: 'draft',
          queueMeta: {
            unresolved: false,
            stalenessDays: 7,
            frozenPriceDisplay: '50,000.00 THB',
            currentCataloguePriceDisplay: '50,000.00 THB',
            priceChanged: false,
            priceUnverifiable: false,
            planYear: 2025,
            currentFiscalYear: 2025,
            billYearStale: false,
            refusalReason: {
              kind: 'duplicate_live_bill',
              conflictingInvoiceId: 'inv-conflict-9',
            },
          },
        }),
      ],
      true,
    );
    const badge = screen.getByTestId('queue-would-be-refused');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('Would be refused');
    expect(
      screen.getByRole('link', { name: 'View existing bill' }),
    ).toHaveAttribute('href', '/admin/invoices/inv-conflict-9');
    expect(screen.getByTestId('queue-staleness')).toHaveTextContent(
      'Drafted 7 days ago',
    );
  });
});

describe('<InvoicesTable> — queue row actions (107-auto-invoice Task 14)', () => {
  const draftRow = baseRow({
    invoiceId: 'inv-queue-draft-1',
    documentNumber: '—',
    status: 'draft',
    hasPdf: false,
    queueMeta: {
      unresolved: false,
      stalenessDays: 1,
      frozenPriceDisplay: '50,000.00 THB',
      currentCataloguePriceDisplay: '50,000.00 THB',
      priceChanged: false,
      priceUnverifiable: false,
      planYear: 2026,
      currentFiscalYear: 2026,
      billYearStale: false,
      refusalReason: null,
    },
  });

  it('canManageQueueActions=true + showQueueMetaColumn=true + status=draft → renders the row actions trigger (not the em-dash)', () => {
    renderQueueTable([draftRow], true, true);
    expect(screen.getByTestId('queue-row-actions-trigger')).toBeInTheDocument();
  });

  it('canManageQueueActions=false (manager) → NO trigger', () => {
    renderQueueTable([draftRow], true, false);
    expect(screen.queryByTestId('queue-row-actions-trigger')).toBeNull();
  });

  it('outside the queue view (showQueueMetaColumn=false) → never renders the trigger, even for a draft row + admin', () => {
    renderQueueTable([draftRow], false, true);
    expect(screen.queryByTestId('queue-row-actions-trigger')).toBeNull();
  });

  it('an already-issued auto-renewal row in the queue view (status cleared filter) → NO row-action trigger (draft-only surface)', () => {
    renderQueueTable(
      [{ ...draftRow, status: 'issued', documentNumber: 'SC2026-00001', hasPdf: true }],
      true,
      true,
    );
    expect(screen.queryByTestId('queue-row-actions-trigger')).toBeNull();
  });
});

/**
 * draft-number-label — Number column click affordance for draft rows.
 *
 * A draft correctly has NO §87 document number (Thai RD §87 allocates only
 * at ISSUE), so `documentNumber` arrives as the sentinel "—". Rendering that
 * bare em-dash as the ONLY click-to-open link failed WCAG 2.5.8 (target <
 * 24px) and 2.4.4 (empty link name, "—, link"). The fix gates on the
 * semantic `status === 'draft'` and swaps in a localised "Draft" placeholder
 * link — normal-weight `text-foreground`, not `font-medium` (so it never reads
 * as a real document number), and deliberately neither italic (Thai has no true
 * italic — faux-oblique bends "ร่าง") nor muted (that colour is the table's
 * "empty / non-actionable" sentinel) — with an aria-label naming the member.
 *
 * These two tests render against the REAL, shipped `en.json` (via
 * `renderTableRealMessages`) rather than the hand-picked `messages` stub
 * used by the rest of this file, so a missing/typo'd `draftNumberLabel` or
 * `actions.openDraftAria` key fails the test instead of silently rendering
 * the dotted key at runtime.
 */
describe('<InvoicesTable> — draft row Number-cell label', () => {
  it('draft row: Number cell is a "Draft" link named for the member, not the bare "—"', () => {
    renderTableRealMessages([
      baseRow({
        status: 'draft',
        documentNumber: '—',
        memberName: 'Acme Co., Ltd.',
      }),
    ]);
    // Visible text is the localised placeholder, not the em-dash sentinel.
    const link = screen.getByRole('link', {
      name: 'Open draft invoice for Acme Co., Ltd.',
    });
    expect(link).toHaveTextContent('Draft');
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-1');
    // No bare "—" link — the WCAG 2.4.4 empty-link-name regression this fixes.
    expect(screen.queryByRole('link', { name: '—' })).toBeNull();
  });

  it('non-draft (issued) row: Number cell still renders documentNumber as the link text (regression)', () => {
    renderTableRealMessages([
      baseRow({ status: 'issued', documentNumber: 'INV-2026-0001' }),
    ]);
    const link = screen.getByRole('link', { name: 'INV-2026-0001' });
    expect(link).toHaveAttribute('href', '/admin/invoices/inv-1');
  });
});

describe('<InvoicesTable> — draft total', () => {
  it('a draft with no computed total renders "—", never "0.00 THB"', () => {
    renderTable([baseRow({ status: 'draft', totalSatang: null })]);
    const cell = screen.getByTestId('invoice-total');
    expect(cell).toHaveTextContent('—');
    expect(cell).not.toHaveTextContent('0.00');
    // The dash is explained to screen readers.
    expect(cell).toHaveTextContent('Not calculated until issued');
  });

  it('an issued invoice keeps its grouped THB total', () => {
    renderTable([baseRow({ totalSatang: '3852000' })]);
    expect(screen.getByTestId('invoice-total')).toHaveTextContent('38,520.00 THB');
  });
});

/**
 * Spec 122 US8 (T802) — the `Admin-invoices` board on AURA's DataTable
 * (spec Clarifications, Session 2026-10-02): the board's column order, the
 * shared status tones, "Issued {date}" and the credit-note count under the
 * number, and the row actions ("Record payment…" + a ⋯ menu).
 */
describe('<InvoicesTable> — the Admin-invoices board (US8 T802)', () => {
  it('an AURA grid with the board columns in order; the Issued column is gone', () => {
    renderTable([baseRow({})]);
    const grid = screen.getByRole('grid', { name: 'List of invoices for the selected filters.' });
    const headers = within(grid)
      .getAllByRole('columnheader')
      .map((h) => h.textContent?.trim());
    expect(headers).toEqual(['Invoice No.', 'Buyer', 'Status', 'Due', 'Receipt No.', 'Total', 'Actions']);
  });

  it('the view columns keep their place: Queue and Method follow Status', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InvoicesTable rows={[baseRow({})]} showQueueMetaColumn showMethodColumn />
      </NextIntlClientProvider>,
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).toEqual([
      'Invoice No.',
      'Buyer',
      'Status',
      'Queue',
      'Method',
      'Due',
      'Receipt No.',
      'Total',
      'Actions',
    ]);
  });

  it('"Issued {date}" and the credit-note count sit under the number', () => {
    renderTable([baseRow({ issueDate: '2026-06-01', creditNoteCount: 2, creditedTotalSatang: '535000' })]);
    const numberCell = screen.getByRole('link', { name: 'INV-2026-0001' }).closest('[role="gridcell"]');
    expect(numberCell).toHaveTextContent('Issued 1 Jun 2026');
    const cn = within(numberCell as HTMLElement).getByRole('link', { name: '2 credit notes, 5,350.00 credited' });
    expect(cn).toHaveTextContent('2 credit notes');
    expect(cn).toHaveAttribute('href', '/admin/invoices/inv-1');
  });

  it.each([
    ['paid', 'ready'],
    ['issued', 'progress'],
    ['overdue', 'blocked'],
    ['void', 'neutral'],
    ['partially_credited', 'neutral'],
  ] as const)('a %s row wears the %s status pill', (status, tone) => {
    renderTable([baseRow({ status })]);
    const statusLabel = messages.admin.invoices.list.statuses[status];
    expect(screen.getByText(statusLabel).closest('.aura-pill')).toHaveClass(`aura-pill--${tone}`);
  });

  it('the online method reads under the receipt number', () => {
    renderTable([
      baseRow({
        status: 'paid',
        receiptDocumentNumberRaw: 'RC-2026-0001',
        hasReceiptPdf: true,
        receiptPdfStatus: 'rendered',
        onlinePaymentMethod: 'promptpay',
      }),
    ]);
    expect(screen.getByText('RC-2026-0001').closest('[role="gridcell"]')).toHaveTextContent('PromptPay');
  });

  it('a failed receipt is a "Receipt render failed" link under the receipt number', () => {
    renderTable([
      baseRow({
        status: 'paid',
        receiptDocumentNumberRaw: 'RC-2026-0003',
        receiptPdfStatus: 'failed',
      }),
    ]);
    const failed = screen.getByTestId('row-receipt-render-failed');
    expect(failed.closest('[role="gridcell"]')).toHaveTextContent('RC-2026-0003');
  });

  it('every row has a ⋯ menu that opens the invoice', () => {
    renderTable([baseRow({ status: 'void', hasPdf: false })]);
    const menu = openRowMenu('INV-2026-0001');
    expect(within(menu).getByRole('menuitem', { name: 'View invoice' })).toHaveAttribute(
      'href',
      '/admin/invoices/inv-1',
    );
  });

  it('"Record payment…" shows for an admin on issued and overdue rows only', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <InvoicesTable
          rows={[
            baseRow({ invoiceId: 'a', documentNumber: 'SC-2026-000001', status: 'issued' }),
            baseRow({ invoiceId: 'b', documentNumber: 'SC-2026-000002', status: 'overdue' }),
            baseRow({ invoiceId: 'c', documentNumber: 'SC-2026-000003', status: 'paid' }),
          ]}
          canRecordPayment
          todayIso="2026-06-20"
        />
      </NextIntlClientProvider>,
    );
    const triggers = screen.getAllByTestId('row-record-payment-trigger');
    expect(triggers.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Record payment for invoice SC-2026-000001',
      'Record payment for invoice SC-2026-000002',
    ]);
  });

  it('a manager (no canRecordPayment) sees no "Record payment…"', () => {
    renderTable([baseRow({ status: 'issued' })]);
    expect(screen.queryByTestId('row-record-payment-trigger')).toBeNull();
  });

  it('the review-queue draft row keeps its own actions and has no download menu', () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <InvoicesTable
          rows={[baseRow({ status: 'draft', documentNumber: '—', hasPdf: false })]}
          showQueueMetaColumn
          canManageQueueActions
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByTestId('queue-row-actions-trigger')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions for —' })).toBeNull();
  });
});
