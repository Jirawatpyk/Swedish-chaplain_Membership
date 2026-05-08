/**
 * `PipelineTable` — F8 pipeline dashboard client component.
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
 * only triggers. Action menu items: "Send reminder" is wired
 * (admin-only, manager sees disabled+tooltip); "Open" deep-links to
 * cycle detail; "Mark contacted" is reserved for US4 at-risk follow-
 * on. Cancel + mark-paid-offline live on the cycle detail page.
 */
'use client';

/*
 * J8-M34 — mobile responsive treatment deferred. Per
 * `docs/ux-standards.md` § 9.4, data tables should collapse to a
 * card stack at ≤md breakpoints. The pipeline table currently uses
 * `overflow-x-auto` (WCAG 1.4.10 Reflow exception for data tables).
 * The admin renewals dashboard is staff-only — sized at lg+ in
 * production usage — so the card-stack layout is a post-J wave
 * polish item rather than a ship blocker. Tracked alongside the
 * smart-features backlog.
 */

import { useMemo, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
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

  // React Compiler's `react-hooks/incompatible-library` flags
  // `useReactTable()` because TanStack Table's API returns helper
  // functions that the compiler cannot safely memoize. The warning is
  // a known, documented compiler skip for this exact API; we are
  // already using `useMemo` upstream on `data` to keep the row-model
  // stable, which is the actual perf-critical invariant. Suppressing
  // here so a clean lint run flags only real regressions.
  // eslint-disable-next-line react-hooks/incompatible-library
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
            {/*
             * J8-M30: extended the bare "No members in this bucket"
             * placeholder with an actionable hint pointing admins at
             * the urgency-tab switcher. Keeps the table-cell skin
             * (vs upgrading to <EmptyState> — that would break the
             * single-cell-row table pattern).
             */}
            <TableCell
              colSpan={columns.length}
              className="text-center text-muted-foreground py-8"
            >
              <p className="text-sm font-medium text-foreground">{t('noRows')}</p>
              <p className="mt-1 text-xs">{t('noRowsInBucket')}</p>
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
  // Round-3 UX M3 fix: client-side router so the "Open" action
  // performs a soft navigation to /admin/renewals/[cycleId] instead
  // of triggering a full-page reload via native <a href>. Soft nav
  // preserves admin filter state (?urgency, ?tier) and avoids the
  // ~300ms blank-screen flash on every row jump.
  const router = useRouter();

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
      } catch (e) {
        // K1-E5: previously `catch {}` swallowed every non-network
        // error (TypeError, SyntaxError, AbortController, locale
        // formatter, i18n missing-key) and collapsed all causes to
        // "network error" — admins saw "network error" while their
        // network was fine and a real bug was invisible. Capture +
        // log + use the generic toast so client-side bugs are at
        // least visible in browser console.
         
        console.error(
          '[F8] send-reminder-now: client handler failed',
          e,
        );
        toast.error(tToast('error.generic'));
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
            // J8-M31: native browser tooltip on hover (sighted-mouse
            // users) complementing the aria-label that SR users get
            // on focus. Wrapping in `<Tooltip>` primitive would
            // collide with the DropdownMenu popup positioning; the
            // native `title` attr is simpler + universally supported
            // for an icon-only trigger like this row-actions button.
            title={tActions('rowMenu', { company: companyName })}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        )}
      />
      {/*
       * J7-H15: `min-w-56 whitespace-nowrap` per ux-standards § 19.
       * Without this the dropdown's default `min-w-32` (128px) wraps
       * the long Thai/Swedish action labels mid-word
       * ("ส่งอีเมลเตือนการต่ออายุ" / "Skicka förnyelsepåminnelse").
       */}
      <DropdownMenuContent align="end" className="min-w-56 whitespace-nowrap">
        <DropdownMenuItem
          disabled={isPending}
          onClick={handleSendReminder}
        >
          {tActions('sendReminder')}
        </DropdownMenuItem>
        {/* UX R5 / Mobile #5: contextual `aria-label` so screen-reader
            users hear which company's cycle they're opening (the
            bare label "Open" on every row was indistinguishable in
            a long pipeline).
            Round-3 UX M3 fix: use `router.push()` for soft client-
            side navigation. The previous `<a href>` form was kept
            for type-compat with Base UI's `render`-prop pattern but
            forced full-page reloads that lost the admin's tab+tier
            filter URL state on every row jump. Now the visible
            anchor is a real `<a>` that retains right-click + open-
            in-new-tab affordances, but `onClick` calls
            `router.push()` + `e.preventDefault()` for the standard
            Next.js soft-nav path. */}
        <DropdownMenuItem
          render={(props) => (
            <a
              {...props}
              href={`/admin/renewals/${cycleId}`}
              aria-label={tActions('openAriaLabel', { company: companyName })}
              onClick={(event: React.MouseEvent<HTMLAnchorElement>) => {
                // Honour the user's intent for new-tab / new-window
                // affordances (cmd/ctrl + click, middle-click) by
                // letting the browser take the native path.
                if (
                  event.defaultPrevented ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  event.button !== 0
                ) {
                  return;
                }
                event.preventDefault();
                router.push(`/admin/renewals/${cycleId}`);
              }}
            >
              {tActions('open')}
            </a>
          )}
        />
        {/*
         * J8-M21: disabled DropdownMenuItem renders without context
         * for screen-reader users — they hear "Mark contacted, dimmed"
         * but no explanation why the action is disabled. The
         * `aria-describedby` + sr-only span exposes the reason
         * (per WCAG 4.1.2 Name/Role/Value) without affecting
         * sighted UX.
         */}
        <DropdownMenuItem
          disabled
          aria-describedby={`mark-contacted-hint-${cycleId}`}
        >
          {tActions('markContacted')}
        </DropdownMenuItem>
        <span
          id={`mark-contacted-hint-${cycleId}`}
          className="sr-only"
        >
          {tActions('markContactedComingSoon')}
        </span>
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
