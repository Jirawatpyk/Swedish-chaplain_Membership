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

  const columns: DataTableColumn<DirectoryTableRow>[] = [
    {
      key: 'companyName',
      label: labels.company,
      render: (row) => (
        <span className="font-medium whitespace-normal text-[var(--aura-fg-accent)] [overflow-wrap:anywhere]">
          {row.companyName}
        </span>
      ),
    },
    { key: 'tier', label: labels.tier, width: 170, render: (row) => row.tier ?? DASH },
    { key: 'industry', label: labels.industry, width: 160, hideBelow: 'lg', render: (row) => row.industry ?? DASH },
    { key: 'location', label: labels.location, width: 130, render: (row) => row.location ?? DASH },
    {
      key: 'listed',
      label: labels.listed,
      width: 90,
      pill: true,
      // The table says Yes / No; a phone card, where the column name is not
      // beside it, says "Listed" / "Not listed" with the pill's icon (boards
      // `Admin-directory` and `-mobile`). AURA app content: swapped on a stacked card.
      render: (row) => (
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
    },
    {
      key: 'hasLogo',
      label: labels.logo,
      width: 64,
      hideBelow: 'lg',
      render: (row) =>
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
    },
    { key: 'contactName', label: labels.contact, width: 150, hideBelow: 'lg', render: (row) => row.contactName ?? DASH },
  ];
  // Industry, Logo and Contact drop out on a table narrower than `lg` (a
  // tablet, or a laptop beside the nav), so the rest fits without scrolling;
  // a phone card still shows every field.

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
    />
  );
}
