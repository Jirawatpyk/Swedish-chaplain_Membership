'use client';

/**
 * F9 US5 (T083) — staff directory results table (FR-024). Presentational:
 * receives display-ready rows + localised labels. Listing status is encoded
 * with a text badge (not colour alone — WCAG 1.4.1).
 *
 * 122 US5a (T506) — AURA `DataTable` (board `Admin-directory`): the company is
 * the row link and the phone card title; "Listed" sits beside it on a card.
 */
import { CheckIcon } from 'lucide-react';
import { Badge, DataTable, type DataTableColumn } from '@jirawatpyk/aura-react';
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
      render: (row) => <span className="font-medium">{row.companyName}</span>,
    },
    {
      key: 'listed',
      label: labels.listed,
      width: 100,
      pill: true,
      render: (row) => (
        <Badge {...(row.listed ? { tone: 'success' as const } : { variant: 'outline' as const })}>
          {row.listed ? labels.yes : labels.no}
        </Badge>
      ),
    },
    { key: 'tier', label: labels.tier, width: 180, render: (row) => row.tier ?? DASH },
    { key: 'industry', label: labels.industry, width: 170, hideBelow: 'lg', render: (row) => row.industry ?? DASH },
    { key: 'location', label: labels.location, width: 140, render: (row) => row.location ?? DASH },
    {
      key: 'hasLogo',
      label: labels.logo,
      width: 80,
      hideBelow: 'lg',
      render: (row) =>
        row.hasLogo ? (
          <span className="inline-flex items-center gap-1">
            <CheckIcon className="size-4" aria-hidden />
            <span className="sr-only">{labels.hasLogo}</span>
          </span>
        ) : (
          <>
            <span aria-hidden>{DASH}</span>
            <span className="sr-only">{labels.no}</span>
          </>
        ),
    },
    { key: 'contactName', label: labels.contact, width: 160, hideBelow: 'lg', render: (row) => row.contactName ?? DASH },
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
      stackBelow={640}
    />
  );
}
