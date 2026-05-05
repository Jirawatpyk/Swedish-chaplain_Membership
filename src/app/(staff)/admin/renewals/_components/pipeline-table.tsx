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

import { useMemo, useTransition } from 'react';
import Link from 'next/link';
import { useTranslations, useFormatter, useLocale } from 'next-intl';
import { toast } from 'sonner';
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
// Client-safe sub-barrel — see `tier-filter-select.tsx` for the
// rationale (Turbopack 16 + F8 barrel + server-only deps).
import type { CycleStatus, PipelineRow } from '@/modules/renewals/client';

export interface PipelineTableProps {
  readonly rows: ReadonlyArray<PipelineRow>;
}

export function PipelineTable({ rows }: PipelineTableProps) {
  const t = useTranslations('admin.renewals.table');
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
            emailUnverified={row.original.emailUnverified}
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
            {/* Template-literal type auto-tracks CycleStatus enum so a
                future status addition becomes a compile error rather
                than a missed translation. */}
            {t(`status.${row.original.status}` as `status.${CycleStatus}`)}
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
          <RowActionsMenu
            cycleId={row.original.cycleId}
            companyName={row.original.companyName}
          />
        ),
      },
    ],
    [t, fmt],
  );

  // Round 5 S-05 — memoise the data array reference so TanStack Table
  // does NOT rebuild its internal row model on every parent re-render.
  // The cast to mutable PipelineRow[] is safe (TanStack does not mutate)
  // but the new array reference per render would otherwise force a
  // ~1-2ms row-model rebuild at the 200-row cap.
  const data = useMemo(() => rows as PipelineRow[], [rows]);

  const table = useReactTable({
    data,
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

// ---------------------------------------------------------------------------
// Wave I6+I7 · T108 — RowActionsMenu
// ---------------------------------------------------------------------------

/**
 * Row-level actions dropdown. Owns its own `useTransition` state so the
 * pipeline table's columns memo stays stable across renders. Mark
 * contacted remains disabled until US4 (Wave J).
 */
function RowActionsMenu({
  cycleId,
  companyName,
}: {
  readonly cycleId: string;
  readonly companyName: string;
}): React.JSX.Element {
  const tActions = useTranslations('admin.renewals.actions');
  const tToast = useTranslations('admin.renewals.sendReminderNow.toast');
  const locale = useLocale();
  const [isPending, startTransition] = useTransition();

  const handleSendReminder = (): void => {
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/admin/renewals/${cycleId}/send-reminder-now`,
          { method: 'POST' },
        );
        if (res.status === 401 || res.status === 403) {
          toast.error(tToast('error.unauthorized'));
          return;
        }
        if (res.status === 429) {
          const retry = res.headers.get('Retry-After') ?? '60';
          toast.error(tToast('error.rateLimited', { seconds: retry }));
          return;
        }
        if (res.status === 409) {
          const body = (await res.json().catch(() => null)) as {
            error?: { existing_dispatched_at?: string };
          } | null;
          const dispatchedAt = body?.error?.existing_dispatched_at;
          const ago = dispatchedAt ? formatRelativeAgo(dispatchedAt, locale) : '';
          toast.warning(tToast('skipped.alreadySent', { ago }));
          return;
        }
        if (!res.ok) {
          toast.error(tToast('error.network'));
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          outcome?: { kind: string; reason?: string };
        } | null;
        const outcome = body?.outcome;
        if (!outcome) {
          toast.error(tToast('error.generic'));
          return;
        }
        switch (outcome.kind) {
          case 'sent':
          case 'task_created':
            toast.success(tToast('sent.title'), {
              description: tToast('sent.description', { company: companyName }),
            });
            break;
          case 'skipped':
            toast.info(toastLabelForSkipReason(outcome.reason ?? 'generic', tToast));
            break;
          case 'failed_transient':
            toast.warning(tToast('failedTransient'));
            break;
          case 'failed_permanent':
            toast.error(tToast('failedPermanent'));
            break;
          default:
            toast.error(tToast('error.generic'));
        }
      } catch {
        toast.error(tToast('error.network'));
      }
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(props) => (
          <Button
            {...props}
            variant="ghost"
            size="icon"
            // 44×44px tap target — WCAG 2.5.5 Target Size (AAA) +
            // iOS HIG 44pt minimum. F3 baseline adopted WCAG 2.5.8
            // (24×24, AA); F8 row-action triggers go a step further
            // because they sit inside a dense data table where
            // mis-taps would route to the wrong row.
            className="h-11 w-11"
            aria-label={tActions('rowMenu', { company: companyName })}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          disabled={isPending}
          onClick={handleSendReminder}
        >
          {tActions('sendReminder')}
        </DropdownMenuItem>
        <DropdownMenuItem
          render={(props) => (
            <a {...props} href={`/admin/renewals/${cycleId}`}>
              {tActions('open')}
            </a>
          )}
        />
        {/* Mark contacted ships in US4 (Wave J). */}
        <DropdownMenuItem disabled>
          {tActions('markContacted')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Render an ISO timestamp as a relative-time phrase ("5 minutes ago" /
 * "ก่อน 5 นาที" / "5 minuter sedan"). Falls back to the raw ISO when
 * `Intl.RelativeTimeFormat` is unavailable.
 */
function formatRelativeAgo(iso: string, locale: string): string {
  const rtfLocale = mapToRtfLocale(locale);
  let target: number;
  try {
    target = new Date(iso).getTime();
    if (!Number.isFinite(target)) return iso;
  } catch {
    return iso;
  }
  const deltaMs = target - Date.now();
  const absSec = Math.abs(deltaMs) / 1000;
  const rtf = new Intl.RelativeTimeFormat(rtfLocale, { numeric: 'auto' });
  if (absSec < 60) return rtf.format(Math.round(deltaMs / 1000), 'second');
  if (absSec < 3600) return rtf.format(Math.round(deltaMs / 60_000), 'minute');
  if (absSec < 86_400) return rtf.format(Math.round(deltaMs / 3_600_000), 'hour');
  return rtf.format(Math.round(deltaMs / 86_400_000), 'day');
}

function mapToRtfLocale(locale: string): string {
  // next-intl 'en' / 'th' / 'sv' map directly to BCP-47 tags.
  return locale === 'th' ? 'th-TH' : locale === 'sv' ? 'sv-SE' : 'en-US';
}

function toastLabelForSkipReason(
  reason: string,
  t: ReturnType<typeof useTranslations<'admin.renewals.sendReminderNow.toast'>>,
): string {
  switch (reason) {
    case 'member_archived':
      return t('skipped.memberArchived');
    case 'member_opted_out':
      return t('skipped.memberOptedOut');
    case 'email_unverified':
      return t('skipped.emailUnverified');
    case 'outreach_in_progress':
      return t('skipped.outreachInProgress');
    case 'no_primary_contact':
      return t('skipped.noPrimaryContact');
    default:
      return t('skipped.generic', { reason });
  }
}
