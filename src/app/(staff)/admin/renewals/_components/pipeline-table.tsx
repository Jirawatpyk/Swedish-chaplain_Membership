/**
 * F8 Phase 3 Wave H4 · T070 — `PipelineTable` client component.
 *
 * TanStack Table v8 with server-side pagination + filter (no client-
 * side filtering — server returns the page). Client-state covers
 * column visibility + row selection (deferred to US3 bulk actions).
 *
 * Each row shows: tier badge · company name · expires_at · urgency
 * pill · last reminder · status · linked invoice · row actions.
 *
 * WCAG 2.1 AA: keyboard-navigable rows, focus ring, screen-reader
 * dates via `<time dateTime>`, action menu uses `Tooltip` for icon-
 * only triggers. The action menu is stub-disabled in Phase 3 (US3
 * lapsed reactivate, US2 send-reminder land in subsequent phases).
 */
'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useTranslations, useFormatter } from 'next-intl';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { UrgencyPill } from '@/components/renewals/urgency-pill';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
import type { PipelineRow } from '@/modules/renewals';

export interface PipelineTableProps {
  readonly rows: ReadonlyArray<PipelineRow>;
}

export function PipelineTable({ rows }: PipelineTableProps) {
  const t = useTranslations('admin.renewals.table');
  const tActions = useTranslations('admin.renewals.actions');
  const fmt = useFormatter();

  const columns = useMemo<ColumnDef<PipelineRow>[]>(
    () => [
      {
        id: 'tier',
        header: t('columns.tier'),
        cell: ({ row }) => <CycleTierCell tier={row.original.tierBucket} />,
      },
      {
        id: 'company',
        header: t('columns.company'),
        cell: ({ row }) => (
          <CycleCompanyCell
            memberId={row.original.memberId}
            companyName={row.original.companyName}
          />
        ),
      },
      {
        id: 'expires',
        header: t('columns.expires'),
        cell: ({ row }) => <CycleExpiresCell expiresAt={row.original.expiresAt} />,
      },
      {
        id: 'urgency',
        header: t('columns.urgency'),
        cell: ({ row }) => <UrgencyPill urgency={row.original.urgency} />,
      },
      {
        id: 'last_reminder',
        header: t('columns.lastReminder'),
        cell: ({ row }) => {
          if (!row.original.lastReminderAt) {
            return <span className="text-muted-foreground">—</span>;
          }
          return (
            <time
              dateTime={row.original.lastReminderAt}
              className="text-sm text-muted-foreground tabular-nums"
            >
              {fmt.relativeTime(new Date(row.original.lastReminderAt), Date.now())}
            </time>
          );
        },
      },
      {
        id: 'status',
        header: t('columns.status'),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {t(
              `status.${row.original.status}` as
                | 'status.upcoming'
                | 'status.reminded'
                | 'status.awaiting_payment'
                | 'status.completed'
                | 'status.lapsed'
                | 'status.cancelled'
                | 'status.pending_admin_reactivation',
            )}
          </span>
        ),
      },
      {
        id: 'invoice',
        header: t('columns.invoice'),
        cell: ({ row }) =>
          row.original.linkedInvoiceId ? (
            <Link
              href={`/admin/invoices/${row.original.linkedInvoiceId}`}
              className="text-sm text-primary hover:underline"
            >
              {t('viewInvoice')}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('columns.actions')}</span>,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  size="sm"
                  aria-label={tActions('rowMenu', {
                    company: row.original.companyName,
                  })}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              )}
            />
            <DropdownMenuContent align="end">
              {/* Send reminder + Mark contacted ship in Phase 4 (US2)
                  + Phase 6 (US4). Keep the menu items disabled but
                  drop the "Coming in USx" parenthetical — production
                  UI doesn't expose phase identifiers. */}
              <DropdownMenuItem disabled>
                {tActions('sendReminder')}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={(props) => (
                  <a
                    {...props}
                    href={`/admin/renewals/${row.original.cycleId}`}
                  >
                    {tActions('open')}
                  </a>
                )}
              />
              <DropdownMenuItem disabled>
                {tActions('markContacted')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [t, tActions, fmt],
  );

  const table = useReactTable({
    data: rows as PipelineRow[],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((hg) => (
          <TableRow key={hg.id}>
            {hg.headers.map((h) => (
              <TableHead key={h.id}>
                {h.isPlaceholder
                  ? null
                  : flexRender(h.column.columnDef.header, h.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={columns.length}
              className="text-center text-muted-foreground py-8"
            >
              {t('noRows')}
            </TableCell>
          </TableRow>
        ) : (
          table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((c) => (
                <TableCell key={c.id}>
                  {flexRender(c.column.columnDef.cell, c.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
