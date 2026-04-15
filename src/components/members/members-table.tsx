'use client';

/**
 * T065 — Members directory table.
 *
 * TanStack Table v8 headless + shadcn Table visual primitives. Rows link
 * to the detail page. Reserves the `member_risk_flag` column for F8 —
 * rendered as a placeholder em-dash per FR-001 note + US2 AS5.
 *
 * Pagination is cursor-based at the server level; this component exposes
 * a "Load more" button that the parent wires to re-fetch with the echoed
 * cursor. For B.2.a we render the first page only and expose the cursor
 * in a URL param when the user clicks Load more.
 */

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  useReactTable,
  getCoreRowModel,
  flexRender,
  createColumnHelper,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export type MembersTableRow = {
  readonly member_id: string;
  readonly company_name: string;
  readonly country: string;
  readonly plan_id: string;
  readonly plan_year: number;
  readonly status: 'active' | 'inactive' | 'archived';
  readonly member_risk_flag: null;
  readonly last_activity_at: string | null;
  readonly primary_contact: {
    readonly contact_id: string;
    readonly first_name: string;
    readonly last_name: string;
    readonly email: string;
  } | null;
};

type Props = {
  readonly rows: readonly MembersTableRow[];
  readonly nextCursor: string | null;
};

const columnHelper = createColumnHelper<MembersTableRow>();

function StatusBadge({ status }: { status: MembersTableRow['status'] }) {
  const t = useTranslations('admin.members.directory');
  const label =
    status === 'active'
      ? t('statusActive')
      : status === 'inactive'
        ? t('statusInactive')
        : t('statusArchived');
  const variant: 'default' | 'secondary' | 'outline' =
    status === 'active'
      ? 'default'
      : status === 'inactive'
        ? 'secondary'
        : 'outline';
  return <Badge variant={variant}>{label}</Badge>;
}

export function MembersTable({ rows, nextCursor }: Props) {
  const t = useTranslations('admin.members.directory');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const columns = [
    columnHelper.accessor('company_name', {
      header: () => t('columns.company'),
      cell: (info) => (
        <span className="font-medium">{info.getValue()}</span>
      ),
    }),
    columnHelper.accessor('country', {
      header: () => t('columns.country'),
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('plan_id', {
      header: () => t('columns.plan'),
      cell: (info) => (
        <span className="font-mono text-xs text-muted-foreground">
          {info.getValue()}
        </span>
      ),
    }),
    columnHelper.accessor('plan_year', {
      header: () => t('columns.year'),
      cell: (info) => info.getValue(),
    }),
    columnHelper.accessor('primary_contact', {
      header: () => t('columns.primaryContact'),
      cell: (info) => {
        const c = info.getValue();
        if (!c) return <span className="text-muted-foreground">{t('noPrimary')}</span>;
        return (
          <div className="flex flex-col">
            <span>{`${c.first_name} ${c.last_name}`.trim()}</span>
            <span className="text-xs text-muted-foreground">{c.email}</span>
          </div>
        );
      },
    }),
    columnHelper.accessor('status', {
      header: () => t('columns.status'),
      cell: (info) => <StatusBadge status={info.getValue()} />,
    }),
    columnHelper.accessor('member_risk_flag', {
      header: () => t('columns.risk'),
      cell: () => (
        <span className="text-muted-foreground" aria-label="placeholder">
          {t('riskPlaceholder')}
        </span>
      ),
    }),
    columnHelper.accessor('last_activity_at', {
      header: () => t('columns.lastActivity'),
      cell: (info) => {
        const v = info.getValue();
        if (!v) return <span className="text-muted-foreground">—</span>;
        // Deterministic ISO date (YYYY-MM-DD). `toLocaleDateString()` on
        // this value disagrees between server (Node default en-US) and
        // client (browser locale, e.g. Thai Buddhist Era) — causes a
        // hydration mismatch. Localised dates belong in a Client Component
        // hydrated after mount, or via next-intl's useFormatter server-side.
        return v.slice(0, 10);
      },
    }),
  ];

  // TanStack Table's useReactTable is incompatible with the React compiler's
  // memoization heuristics (it returns fresh function references every render
  // by design). Silence the "Compilation Skipped" warning — the component is
  // small enough that lack of auto-memo is a non-issue, and the table renders
  // only the visible page (≤100 rows per SC-002).
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: rows as MembersTableRow[],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const onLoadMore = () => {
    if (!nextCursor) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set('cursor', nextCursor);
    router.replace(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    scope="col"
                    className="text-xs uppercase tracking-wide text-muted-foreground"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => {
              const m = row.original;
              return (
                <TableRow
                  key={row.id}
                  className="cursor-pointer hover:bg-accent/40 focus-within:bg-accent/40"
                >
                  {row.getVisibleCells().map((cell, idx) => (
                    <TableCell key={cell.id} className="align-top">
                      {idx === 0 ? (
                        <Link
                          href={`/admin/members/${m.member_id}`}
                          aria-label={t('rowAriaLabel', { company: m.company_name })}
                          className="focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </Link>
                      ) : (
                        flexRender(cell.column.columnDef.cell, cell.getContext())
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {nextCursor && (
        <div className="flex justify-center">
          <Button type="button" variant="outline" size="sm" onClick={onLoadMore}>
            {t('loadMore')}
          </Button>
        </div>
      )}
    </div>
  );
}
