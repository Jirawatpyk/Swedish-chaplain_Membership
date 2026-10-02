'use client';

/**
 * Spec 122 US8 (T809) — the invoices table's loading skeleton: AURA's own
 * `DataTable` in its loading state with the real table's columns (keys,
 * sizes and phone-card parts from `INVOICES_COLUMN_LAYOUT`), so it turns into
 * cards below 640px like the real one and the rows land in place (the
 * `MembersTableSkeleton` precedent). The labels come from the route's
 * server `loading.tsx`, which has its translations before any client
 * provider runs.
 */
import { DataTable, type DataTableColumn } from '@jirawatpyk/aura-react';
import { INVOICES_COLUMN_LAYOUT, type InvoicesColumnKey } from './invoices-table-columns';

interface InvoicesTableSkeletonProps {
  readonly caption: string;
  readonly labels: Readonly<Record<InvoicesColumnKey, string>>;
}

export function InvoicesTableSkeleton({ caption, labels }: InvoicesTableSkeletonProps) {
  const columns: DataTableColumn[] = (Object.keys(INVOICES_COLUMN_LAYOUT) as InvoicesColumnKey[]).map((key) => ({
    key,
    label: labels[key],
    ...INVOICES_COLUMN_LAYOUT[key],
  }));
  // `inert` with `aria-hidden`: a placeholder takes no keyboard focus.
  return (
    <div aria-hidden inert data-testid="invoices-table-skeleton">
      <DataTable
        label={caption}
        rows={[]}
        columns={columns}
        rowKey="invoiceId"
        loading
        skeletonRows={10}
        rowHeight="auto"
        stackBelow={640}
        // edge to edge inside the list card, as the table is
        bleed
      />
    </div>
  );
}
