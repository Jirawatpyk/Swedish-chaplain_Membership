'use client';

/**
 * 122 US5b-1 (T556) — the member's invoices on AURA `DataTable` (board
 * `Admin-member-detail`): Number (with its status pill), Issued, Due, Paid,
 * Total, Remaining and a "⋯" row menu. Stacked into cards on a phone.
 *
 * The server formats every figure (`MemberInvoicesSection`); this only lays
 * the rows out, so the money shown is exactly what the section computed. The
 * menu keeps the destinations the row buttons had — View, Record payment
 * (issued), Void (issued; its own confirmation page) and Issue credit note
 * (paid / partly credited). For a manager, read-only on finance, the mutating
 * items stay listed but disabled with the reason, as the tooltip said.
 */
import { useMemo } from 'react';
import { DataTable, DropdownMenu, IconButton, StatusPill, type DataTableColumn, type MenuItem } from '@jirawatpyk/aura-react';
import type { InvoiceStatus } from '@/modules/invoicing';
import { invoiceStatusTone } from '@/components/invoices/invoice-status-tone';

export interface MemberInvoiceRow {
  readonly invoiceId: string;
  /** The resolved document number, or the draft placeholder. */
  readonly number: string;
  readonly status: InvoiceStatus;
  readonly statusLabel: string;
  readonly issued: string;
  readonly due: string;
  /** `null` — not paid yet. */
  readonly paid: string | null;
  readonly total: string;
  readonly remaining: string;
  /** Flags the Remaining figure: set only on an `issued` row, the one unpaid state (matches the figures strip's Outstanding). */
  readonly owing: boolean;
  // DataTable reads rows as records.
  readonly [key: string]: unknown;
}

export interface MemberInvoicesTableLabels {
  readonly caption: string;
  readonly number: string;
  readonly status: string;
  readonly issued: string;
  readonly due: string;
  readonly paid: string;
  readonly total: string;
  readonly remaining: string;
  readonly notPaid: string;
  /** "Actions for {number}" */
  readonly actionsFor: string;
  readonly view: string;
  readonly recordPayment: string;
  readonly issueCreditNote: string;
  readonly void: string;
  readonly disabledForManager: string;
}

function menuItems(row: MemberInvoiceRow, labels: MemberInvoicesTableLabels, canMutate: boolean): MenuItem[] {
  const base = `/admin/invoices/${row.invoiceId}`;
  const gated = (label: string, href: string, extra: Partial<MenuItem> = {}): MenuItem =>
    canMutate ? { label, href, ...extra } : { label, disabled: true, disabledReason: labels.disabledForManager, ...extra };
  const items: MenuItem[] = [{ label: labels.view, href: base, icon: 'file-text' }];
  if (row.status === 'issued') {
    // W1-44: the RecordPaymentDialog trigger on the issued invoice's page.
    items.push(gated(labels.recordPayment, `${base}#record-payment`));
  }
  if (row.status === 'paid' || row.status === 'partially_credited') {
    items.push(gated(labels.issueCreditNote, `${base}/credit-notes/new`));
  }
  if (row.status === 'issued') {
    // Void opens its own confirmation page; last, after a separator.
    items.push({ separator: true }, gated(labels.void, `${base}/void`, { tone: 'danger' }));
  }
  return items;
}

/**
 * Table width (px) from which Status is its own column. The stacked pill
 * hides from a 712px WRAPPER: `bleed` makes the table 2 × 24px (the card's
 * padding) wider than its wrapper, so 712 + 48 = 760 and exactly one of the
 * two shows (checked at 1280 and 1440).
 */
const STATUS_COLUMN_FROM = 760;

export function MemberInvoicesTable({
  rows,
  labels,
  canMutate,
}: {
  readonly rows: readonly MemberInvoiceRow[];
  readonly labels: MemberInvoicesTableLabels;
  readonly canMutate: boolean;
}) {
  // Memoised: a fresh `columns` array on every render remounts each cell, and
  // the row menu closed on the same click that opened it (R18).
  const columns: DataTableColumn<MemberInvoiceRow>[] = useMemo(() => [
    // Status is its own column, as the board draws it, once the table is
    // STATUS_COLUMN_FROM px wide (AURA `hideBelow` reads the table's width).
    // Narrower — the 655px main column at 1280 — the column drops and the pill
    // shows under the number instead, so every other column still fits
    // (PR P). The stacked pill follows the wrapper's width (a named
    // `@container`), offset by the bleed (see STATUS_COLUMN_FROM), so exactly
    // one of the two shows. The phone card keeps its own
    // title and pill slots.
    {
      key: 'number',
      label: labels.number,
      card: 'hide',
      render: (row) => (
        <span className="flex flex-col items-start gap-1">
          <span className="font-mono">{row.number}</span>
          <span data-stacked-status="" className="@min-[712px]/invoices:hidden">
            <StatusPill tone={invoiceStatusTone(row.status)}>{row.statusLabel}</StatusPill>
          </span>
        </span>
      ),
    },
    {
      key: 'status',
      label: labels.status,
      // Fixed, so only Number flexes: the six columns need ~716px and fit a
      // 760px table without scrolling (unfixed, Status took the flexible 160).
      width: 120,
      hideBelow: STATUS_COLUMN_FROM,
      card: 'pill',
      render: (row) => <StatusPill tone={invoiceStatusTone(row.status)}>{row.statusLabel}</StatusPill>,
    },
    // The phone board's card shows Due, Total and Remaining only.
    { key: 'issued', label: labels.issued, width: 120, hideBelow: 'lg', card: 'hide' },
    { key: 'due', label: labels.due, width: 120 },
    {
      key: 'paid',
      label: labels.paid,
      width: 120,
      hideBelow: 'lg',
      card: 'hide',
      // The board prints "Not paid yet" (G-U7P: words, never a bare dash).
      render: (row) => row.paid ?? <span className="text-[var(--aura-fg-secondary)]">{labels.notPaid}</span>,
    },
    { key: 'total', label: labels.total, width: 130, align: 'end', render: (row) => row.total },
    {
      key: 'remaining',
      label: labels.remaining,
      width: 130,
      align: 'end',
      // AURA's warning text token (≥6.8:1 in both themes); the chip ink
      // `--aura-status-warning-fg` is near-black on the dark surface.
      render: (row) =>
        row.owing ? <span className="font-medium text-[var(--aura-fg-warning)]">{row.remaining}</span> : row.remaining,
    },
    {
      key: 'actions',
      label: '',
      width: 56,
      actions: true,
      render: (row) => {
        const name = labels.actionsFor.replace('{number}', row.number);
        return (
          <DropdownMenu
            label={name}
            trigger={<IconButton icon="ellipsis" size="sm" touchHeight label={name} />}
            items={menuItems(row, labels, canMutate)}
          />
        );
      },
    },
    // Card-only column (AURA 5.85 #198 `grid: false`): the phone card's
    // title; never drawn in the grid. Stand-in until AURA #200: it sits LAST
    // because AURA still counts grid:false columns in the grid's
    // aria-colcount and each cell's aria-colindex, so placed before the
    // visible columns it opened a gap.
    { key: 'cardNumber', label: labels.number, mono: true, card: 'title', grid: false, render: (row) => row.number },
  ], [labels, canMutate]);

  return (
    // The query container for the stacked status pill, NAMED: AURA's table
    // nests its own inline-size containers (its hideBelow / stackBelow
    // queries, thousands of px wide), so an unnamed query would read those.
    // No padding, frame or clipping, so the table still bleeds to the card's
    // edges.
    // `member-invoices-list`: on a phone the stacked rows are one list
    // divided by rules inside the framed Invoices card (globals.css,
    // stand-in until AURA #204).
    <div className="@container/invoices member-invoices-list">
      <DataTable<MemberInvoiceRow>
        label={labels.caption}
        rows={rows as MemberInvoiceRow[]}
        columns={columns}
        rowKey="invoiceId"
        manual
        rowHeight="auto"
        stackBelow={640}
        // Edge to edge inside the Invoices card, as every list table is.
        bleed
      />
    </div>
  );
}
