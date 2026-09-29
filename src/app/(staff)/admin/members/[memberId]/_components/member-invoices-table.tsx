'use client';

/**
 * 122 US5b-1 (T556) — the member's invoices on AURA `DataTable` (board
 * `Admin-member-detail`): Number, Status, Issued, Due, Paid, Total, Remaining
 * and a "⋯" row menu. Stacked into cards on a phone.
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

const STATUS_TONE: Readonly<Record<InvoiceStatus, 'neutral' | 'progress' | 'ready'>> = {
  draft: 'neutral',
  issued: 'progress',
  paid: 'ready',
  void: 'neutral',
  credited: 'neutral',
  partially_credited: 'neutral',
};

/**
 * An end-aligned figure, start-aligned in the phone card under its label, as
 * the phone board has it. AURA keeps a column's end alignment inside stacked
 * cards (handoff #108); this is our own markup, not a reach into AURA's.
 */
function StartOnCard({ children }: { readonly children: React.ReactNode }) {
  return <span className="block max-[639px]:text-start">{children}</span>;
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
    { key: 'number', label: labels.number, mono: true, card: 'title' },
    {
      key: 'status',
      label: labels.status,
      width: 140,
      card: 'pill',
      render: (row) => <StatusPill tone={STATUS_TONE[row.status]}>{row.statusLabel}</StatusPill>,
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
    { key: 'total', label: labels.total, width: 130, align: 'end', render: (row) => <StartOnCard>{row.total}</StartOnCard> },
    {
      key: 'remaining',
      label: labels.remaining,
      width: 130,
      align: 'end',
      render: (row) => (
        <StartOnCard>
          {row.owing ? <span className="font-medium text-[var(--aura-alert-warning-fg)]">{row.remaining}</span> : row.remaining}
        </StartOnCard>
      ),
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
            trigger={<IconButton icon="ellipsis" size="sm" label={name} />}
            items={menuItems(row, labels, canMutate)}
          />
        );
      },
    },
  ], [labels, canMutate]);

  return (
    <DataTable<MemberInvoiceRow>
      label={labels.caption}
      rows={rows as MemberInvoiceRow[]}
      columns={columns}
      rowKey="invoiceId"
      manual
      rowHeight="auto"
      stackBelow={640}
    />
  );
}
