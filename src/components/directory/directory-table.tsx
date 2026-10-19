'use client';

/**
 * F9 US5 (T083) — staff directory results table (FR-024). Presentational:
 * receives display-ready rows + localised labels. Listing status is encoded
 * with a text badge (not colour alone — WCAG 1.4.1).
 *
 * 122 US5a (T506) — AURA `DataTable` (board `Admin-directory`): the company is
 * the row link (in the link colour) and the phone card title; the columns
 * follow the board's order, and "Listed" sits beside the title on a card.
 */
import { CheckIcon } from 'lucide-react';
import { Badge, DataTable, StatusPill, type DataTableColumn } from '@jirawatpyk/aura-react';
import { EmptyState } from '@/components/shell/empty-state';
import { DIRECTORY_COLUMN_LAYOUT, type DirectoryColumnKey } from './directory-table-layout';

export interface DirectoryTableRow {
  readonly memberId: string;
  readonly companyName: string;
  readonly tier: string | null;
  readonly industry: string | null;
  readonly location: string | null;
  readonly listed: boolean;
  readonly hasLogo: boolean;
  readonly contactName: string | null;
}

export interface DirectoryTableLabels {
  readonly caption: string;
  readonly company: string;
  readonly tier: string;
  readonly industry: string;
  readonly location: string;
  readonly listed: string;
  readonly logo: string;
  readonly contact: string;
  readonly hasLogo: string;
  readonly yes: string;
  readonly no: string;
  /** The phone card's pill ("Listed" / "Not listed"), board `Admin-directory-mobile`. */
  readonly listedPill: string;
  readonly notListedPill: string;
  readonly emptyTitle: string;
  readonly empty: string;
}

const DASH = '—';

export function DirectoryTable({
  rows,
  labels,
}: {
  readonly rows: readonly DirectoryTableRow[];
  readonly labels: DirectoryTableLabels;
}): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState title={labels.emptyTitle} description={labels.empty} />;
  }

  const render: Record<DirectoryColumnKey, (row: DirectoryTableRow) => React.ReactNode> = {
    companyName: (row) => (
      <span className="font-medium whitespace-normal text-[var(--aura-fg-accent)] [overflow-wrap:anywhere]">
        {row.companyName}
      </span>
    ),
    tier: (row) => row.tier ?? DASH,
    industry: (row) => row.industry ?? DASH,
    location: (row) => row.location ?? DASH,
    // The table says Yes / No; a phone card, where the column name is not
    // beside it, says "Listed" / "Not listed" with the pill's icon (boards
    // `Admin-directory` and `-mobile`). AURA app content: swapped on a stacked card.
    listed: (row) => (
      <>
        <span className="in-[.aura-table--stacked]:hidden">
          <Badge {...(row.listed ? { tone: 'success' as const } : { variant: 'outline' as const })}>
            {row.listed ? labels.yes : labels.no}
          </Badge>
        </span>
        <span className="hidden in-[.aura-table--stacked]:inline-flex">
          <StatusPill tone={row.listed ? 'ready' : 'neutral'}>
            {row.listed ? labels.listedPill : labels.notListedPill}
          </StatusPill>
        </span>
      </>
    ),
    hasLogo: (row) =>
      row.hasLogo ? (
        <span className="flex items-center gap-1">
          <CheckIcon className="block size-4" aria-hidden />
          <span className="sr-only">{labels.hasLogo}</span>
        </span>
      ) : (
        <>
          <span aria-hidden>{DASH}</span>
          <span className="sr-only">{labels.no}</span>
        </>
      ),
    contactName: (row) => row.contactName ?? DASH,
  };
  // Keys, labels and sizes come from the layout the loading skeleton shares.
  const columns: DataTableColumn<DirectoryTableRow>[] = DIRECTORY_COLUMN_LAYOUT.map(
    ({ labelKey, ...column }) => ({ ...column, label: labels[labelKey], render: render[column.key] }),
  );
  return (
    <DataTable<DirectoryTableRow>
      label={labels.caption}
      rows={rows}
      columns={columns}
      rowKey="memberId"
      manual
      getRowHref={(row) => `/admin/members/${row.memberId}`}
      // Rows grow to fit (AURA 5.11): a long company name wraps in full.
      rowHeight="auto"
      stackBelow={640}
      // Edge to edge inside the Members card, as every list table is (AURA
      // `bleed`); the pager follows, so it does not end the card.
      bleed
    />
  );
}
