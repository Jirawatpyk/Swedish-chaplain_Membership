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
 * dates via `<time dateTime>`, the icon-only row-actions trigger uses
 * the native `title` attribute (no `Tooltip` primitive — it collides
 * with the DropdownMenu popup positioning). Row actions: "Send
 * reminder" is a one-click visible button (manager mutations are
 * blocked server-side at the route handler, not via a client-disabled
 * item); the ⋯ menu keeps "Open" (deep-links to cycle detail) and
 * "Mark contacted" (opens the shared `OutreachDialog`, lifted to this
 * component so it survives the menu closing). Cancel + mark-paid-
 * offline live on the cycle detail page.
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

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
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
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  Loader2Icon,
  MoreHorizontal,
} from 'lucide-react';
import { mergeRefs } from '@/lib/merge-refs';
import { UrgencyPill } from '@/components/renewals/urgency-pill';
import {
  CycleTierCell,
  CycleCompanyCell,
  CycleExpiresCell,
} from '@/components/renewals/cycle-cells';
import { RelativeTime } from '@/components/ui/relative-time';
import { OutreachDialog } from './outreach-dialog';
import { MarkPaidOfflineDialog } from './mark-paid-offline-dialog';
import { shouldOfferMarkPaid } from '../_lib/mark-paid-gate';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for the
// rationale (Turbopack 16 + F8 barrel + server-only deps).
import type { CycleStatus, PipelineRow, PipelineSort } from '@/modules/renewals/client';

export interface PipelineTableProps {
  readonly rows: ReadonlyArray<PipelineRow>;
  /** When set, the empty state reads "No members renew in {month}" (month lens). */
  readonly monthLabel?: string;
  /**
   * Discriminates the month-lens empty copy — `overdue`/`later` get
   * dedicated grammatical strings instead of composing `monthLabel` into
   * the generic "renew in {month}" frame (deferred fix-wave-2 #4). Absent
   * (undefined) preserves the pre-existing `monthLabel`-only behaviour.
   */
  readonly monthKind?: 'overdue' | 'later' | 'month';
  /**
   * Task 8 — the ACTIVE server-side sort. Drives the `aria-sort` state + the
   * direction chevron on the `tier`/`expires` headers. Present together with
   * `sortHrefs` (both come from the page); absent ⇒ headers render as plain
   * text (backwards-compatible with callers that don't wire sorting).
   */
  readonly sort?: PipelineSort;
  /**
   * Task 8 — precomputed header sort links (built server-side in the page so
   * they preserve `tier`/`urgency`/`month`, toggle direction, and DELETE the
   * pagination `cursor` on a sort change). Keyed by the sortable column id.
   */
  readonly sortHrefs?: Record<'expires' | 'tier', string>;
}

/** `localStorage` key for the client row-density preference (Task 8). */
const DENSITY_STORAGE_KEY = 'renewals.pipeline.density';
type Density = 'comfortable' | 'compact';

/** `aria-sort` token for a sortable column under the active sort (WCAG 1.3.1). */
function ariaSortForColumn(
  columnId: 'tier' | 'expires',
  sort: PipelineSort | undefined,
): 'ascending' | 'descending' | 'none' {
  if (columnId === 'expires') {
    return sort === 'expires_at_asc'
      ? 'ascending'
      : sort === 'expires_at_desc'
        ? 'descending'
        : 'none';
  }
  return sort === 'tier_asc'
    ? 'ascending'
    : sort === 'tier_desc'
      ? 'descending'
      : 'none';
}

/**
 * A sortable column header rendered as a plain anchor (`sortHrefs` are built
 * server-side, so sorting works without JS — same discipline as the "Next 50"
 * pagination link). The `aria-sort` state lives on the `<TableHead>`
 * columnheader (never on this link — WCAG 1.3.1 / 4.1.2), so the link only
 * needs an action label + the direction chevron.
 */
function SortHeaderLink({
  href,
  label,
  state,
  actionLabel,
  activeStateLabel,
}: {
  readonly href: string;
  readonly label: ReactNode;
  readonly state: 'ascending' | 'descending' | 'none';
  readonly actionLabel: string;
  readonly activeStateLabel: string | undefined;
}) {
  const Icon =
    state === 'ascending'
      ? ArrowUpIcon
      : state === 'descending'
        ? ArrowDownIcon
        : ArrowUpDownIcon;
  return (
    <a
      href={href}
      aria-label={actionLabel}
      {...(activeStateLabel !== undefined ? { title: activeStateLabel } : {})}
      className="inline-flex items-center gap-1 whitespace-nowrap hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
    >
      {label}
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    </a>
  );
}

export function PipelineTable({
  rows,
  monthLabel,
  monthKind,
  sort,
  sortHrefs,
}: PipelineTableProps) {
  const t = useTranslations('admin.renewals.table');

  // Task 8 — client row-density preference. Defaults to `comfortable` on the
  // server + first client render (no localStorage read during render → no
  // hydration mismatch), then a mount effect syncs the stored choice. Same
  // post-hydration pattern as the theme/sidebar toggles.
  const [density, setDensity] = useState<Density>('comfortable');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
      if (stored === 'compact' || stored === 'comfortable') setDensity(stored);
    } catch {
      /* localStorage unavailable (private mode / SSR) — keep the default */
    }
  }, []);
  const toggleDensity = (): void => {
    setDensity((prev) => {
      const next: Density = prev === 'compact' ? 'comfortable' : 'compact';
      try {
        window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
      } catch {
        /* best-effort persistence */
      }
      return next;
    });
  };
  const densityClass = density === 'compact' ? '[&_td]:py-1.5' : '[&_td]:py-3';
  // Item ② — outreach state lifted up from the row-level menu so the
  // `OutreachDialog` survives the ⋯ menu closing (same lifted-state
  // pattern as lapsed-tab.tsx + at-risk-widget.tsx). Review fix #5:
  // `finalFocus` carries a ref to the row's own ⋯ trigger (set by
  // `RowActions`) so Base UI returns focus there when the dialog closes,
  // instead of the default focus-restore target (the now-unmounted
  // "Mark contacted" menu item) dropping focus to `<body>`.
  const [outreachFor, setOutreachFor] = useState<{
    memberId: string;
    companyName: string;
    finalFocus: React.RefObject<HTMLElement | null>;
  } | null>(null);

  // Task 5 (Wave 2) — same lifted-state pattern as `outreachFor` above, so
  // the shared `MarkPaidOfflineDialog` (the SAME dialog/route the cycle-
  // detail page's "Mark paid offline" button opens — Principle IV, no
  // second settlement path) survives the ⋯ menu closing. `finalFocus` is
  // set by `RowActions` to its own ⋯ trigger; the dialog falls back to
  // `#main-content` when a settlement's `router.refresh()` unmounts the row
  // (see `mark-paid-offline-dialog.tsx`'s docstring).
  //
  // I-1 review-fix — `companyName` rides along so the dialog can show
  // "For {company}" (same value already passed to the ⋯ trigger's
  // aria-label + to `OutreachDialog`), giving the admin an in-dialog
  // confirmation of WHICH member this money mutation settles.
  const [markPaidFor, setMarkPaidFor] = useState<{
    cycleId: string;
    companyName: string;
    finalFocus: React.RefObject<HTMLElement | null>;
  } | null>(null);

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
          // Root-cause hydration fix: `<RelativeTime>` renders an
          // absolute date on the server (stable across SSR + first
          // paint), then flips to "X seconds ago" relative-time after
          // `useEffect` runs client-side. Replaces an earlier inline
          // `Date.now()` call inside `useMemo` that produced
          // different text on SSR vs CSR (the canonical "44 vs 45
          // seconds ago" hydration mismatch).
          return (
            <RelativeTime
              iso={row.original.lastReminderAt}
              className="text-sm text-muted-foreground tabular-nums"
            />
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
          ) : row.original.anchored ? (
            // plan-change-ux seam 1(b) — the cycle's period is already
            // COVERED (rolling-anchor) but no RENEWAL invoice is linked yet
            // (the paying invoice is the prior/anchor one, which for the R4
            // backfill cohort may not be in the system at all). Show
            // "Covered" — coverage language that describes the period being
            // covered WITHOUT asserting a current payment status or an
            // invoice — so the cell is never misread as "payment owed" when
            // paired with a pre-expiry countdown pill. `title` gives sighted
            // mouse users the reason; the `sr-only` span exposes the SAME
            // reason to keyboard/touch/screen-reader users (a `title` on a
            // non-interactive span is not reliably announced). Text label
            // (not colour alone) carries the meaning — WCAG 1.4.1; the
            // `--success` design token themes light/dark (ux-standards § 1.2).
            <span
              className="text-sm font-medium text-success"
              title={t('invoiceCoveredTitle')}
            >
              {t('invoiceCoveredLabel')}
              <span className="sr-only"> — {t('invoiceCoveredTitle')}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">{t('columns.actions')}</span>,
        cell: ({ row }) => (
          <RowActions
            cycleId={row.original.cycleId}
            memberId={row.original.memberId}
            companyName={row.original.companyName}
            status={row.original.status}
            onRecordOutreach={setOutreachFor}
            onMarkPaid={setMarkPaidFor}
          />
        ),
      },
    ],
    [t],
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
    <>
      {/* Task 8 — client row-density toggle, top-right of the table. Its
          accessible name IS the visible mode text (WCAG 2.5.3 Label in Name);
          `title` names the control's purpose, `aria-pressed` exposes the
          compact state. */}
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          aria-pressed={density === 'compact'}
          title={t('density.label')}
          onClick={toggleDensity}
        >
          {density === 'compact' ? t('density.compact') : t('density.comfortable')}
        </Button>
      </div>
      <Table className={densityClass} data-density={density}>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => {
                const colId = h.column.id;
                const sortColId =
                  colId === 'tier' || colId === 'expires' ? colId : null;
                const sortable = sortHrefs !== undefined && sortColId !== null;
                const ariaSort =
                  sortable && sortColId !== null
                    ? ariaSortForColumn(sortColId, sort)
                    : undefined;
                return (
                  <TableHead
                    key={h.id}
                    {...(ariaSort !== undefined ? { 'aria-sort': ariaSort } : {})}
                  >
                    {h.isPlaceholder ? null : sortable &&
                      sortColId !== null &&
                      sortHrefs ? (
                      <SortHeaderLink
                        href={sortHrefs[sortColId]}
                        label={
                          sortColId === 'tier'
                            ? t('columns.tier')
                            : t('columns.expires')
                        }
                        state={ariaSort ?? 'none'}
                        actionLabel={t('sort.sortBy', {
                          column:
                            sortColId === 'tier'
                              ? t('columns.tier')
                              : t('columns.expires'),
                        })}
                        activeStateLabel={
                          ariaSort === 'ascending'
                            ? t('sort.ascending')
                            : ariaSort === 'descending'
                              ? t('sort.descending')
                              : undefined
                        }
                      />
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </TableHead>
                );
              })}
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
                {monthKind === 'overdue' ? (
                  <p className="text-sm font-medium text-foreground">
                    {t('noRowsOverdue')}
                  </p>
                ) : monthKind === 'later' && monthLabel !== undefined ? (
                  <p className="text-sm font-medium text-foreground">
                    {t('noRowsLater', { month: monthLabel })}
                  </p>
                ) : (monthKind === 'month' || monthKind === undefined) &&
                  monthLabel !== undefined ? (
                  <p className="text-sm font-medium text-foreground">
                    {t('noRowsInMonth', { month: monthLabel })}
                  </p>
                ) : (
                  <>
                    <p className="text-sm font-medium text-foreground">{t('noRows')}</p>
                    <p className="mt-1 text-xs">{t('noRowsInBucket')}</p>
                  </>
                )}
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
      {outreachFor ? (
        <OutreachDialog
          open
          onOpenChange={(open) => {
            if (!open) setOutreachFor(null);
          }}
          memberId={outreachFor.memberId}
          memberCompanyName={outreachFor.companyName}
          finalFocus={outreachFor.finalFocus}
        />
      ) : null}
      {markPaidFor ? (
        <MarkPaidOfflineDialog
          open
          onOpenChange={(open) => {
            if (!open) setMarkPaidFor(null);
          }}
          cycleId={markPaidFor.cycleId}
          companyName={markPaidFor.companyName}
          finalFocus={markPaidFor.finalFocus}
        />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Wave I6+I7 · T108 — RowActions
// ---------------------------------------------------------------------------

/**
 * Row-level actions. Owns its own `useTransition` state so the
 * pipeline table's columns memo stays stable across renders. Item ②:
 * "Send reminder" is promoted out of the ⋯ menu to a one-click visible
 * button; the ⋯ menu keeps "Open" + "Mark contacted" (the latter now
 * opens the shared `OutreachDialog` via `onRecordOutreach`, lifted to
 * `PipelineTable` so the dialog survives this menu closing) + Task 5's
 * "Mark paid" (offered only when `shouldOfferMarkPaid(status)` — mirrors
 * the mark-paid-offline route's own state-machine guard so this row never
 * offers a control the API would reject).
 */
function RowActions({
  cycleId,
  memberId,
  companyName,
  status,
  onRecordOutreach,
  onMarkPaid,
}: {
  readonly cycleId: string;
  readonly memberId: string;
  readonly companyName: string;
  readonly status: CycleStatus;
  readonly onRecordOutreach: (t: {
    memberId: string;
    companyName: string;
    finalFocus: React.RefObject<HTMLElement | null>;
  }) => void;
  readonly onMarkPaid: (t: {
    cycleId: string;
    companyName: string;
    finalFocus: React.RefObject<HTMLElement | null>;
  }) => void;
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
  // Review fix #5 — persistent ref to this row's ⋯ trigger button.
  // Merged (not overridden) with Base UI's own DropdownMenuTrigger ref
  // below (see `mergeRefs` docstring: a bare `ref=` on the render-prop
  // element replaces Base UI's ref and the menu stops anchoring). Handed
  // to `onRecordOutreach` as `finalFocus` so the shared `OutreachDialog`
  // returns focus to this row's ⋯ button on close, rather than the
  // default target (the "Mark contacted" menu item, which has just
  // unmounted — dropping focus to `<body>`).
  const rowMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

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
    <div className="flex items-center justify-end gap-1">
      {/* Item ② — primary outreach action promoted to a one-click visible
          button. h-9 matches the app's text-button convention (Button
          `default` size — also used by the at-risk widget's Contact
          button on this same page and the broadcasts primary CTA); the
          44px (`h-11 w-11`) treatment below is reserved for icon-only ⋯
          row-triggers, where a mis-tap routes to the wrong row — a
          different concern than a wide labelled text button. */}
      <Button
        variant="outline"
        size="sm"
        className="h-9"
        disabled={isPending}
        aria-busy={isPending}
        onClick={handleSendReminder}
        aria-label={tActions('sendReminderAriaLabel', { company: companyName })}
      >
        {/* Review fix #4 — progress affordance now that this action is a
            persistent button (was a one-shot menu item). Icon is
            `aria-hidden`; `aria-busy` on the Button itself is what SR
            users get, mirroring the `Loader2` + `aria-busy` pattern used
            across the app's other pending-submit buttons (e.g.
            invoice-settings-form.tsx). */}
        {isPending && (
          <Loader2Icon className="size-4 motion-safe:animate-spin" aria-hidden />
        )}
        {tActions('sendReminder')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={({ ref: baseRef, ...props }) => (
            <Button
              {...props}
              // Base UI passes its OWN ref inside `props` (React 19). A bare
              // `ref={rowMenuTriggerRef}` here would OVERRIDE that ref (only
              // the rightmost ref survives a plain assignment) and the
              // Positioner would lose its anchor — the menu would stop
              // opening. `mergeRefs` forwards both. See that helper's
              // docstring for the full "Base UI render-prop ref trap".
              ref={mergeRefs(baseRef, rowMenuTriggerRef)}
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
          {/* Item ② — was a permanently-disabled US4 stub; now opens the
              already-shipped OutreachDialog (same "Mark contacted" label +
              wiring as lapsed-tab.tsx:254). State is lifted to PipelineTable
              so the dialog outlives this menu closing. */}
          <DropdownMenuItem
            onClick={() =>
              onRecordOutreach({
                memberId,
                companyName,
                finalFocus: rowMenuTriggerRef,
              })
            }
          >
            {tActions('markContacted')}
          </DropdownMenuItem>
          {/* Task 5 (Wave 2) — brings COLLECT onto the pipeline: opens the
              SAME mark-paid-offline dialog/route the cycle-detail page uses
              (Principle IV, no second settlement path), lifted to
              PipelineTable so it survives this menu closing. `finalFocus`
              carries this row's own ⋯ trigger — see mark-paid-offline-
              dialog.tsx for why the dialog falls back to #main-content
              instead when a settlement's refresh unmounts this row. */}
          {shouldOfferMarkPaid(status) ? (
            <DropdownMenuItem
              onClick={() =>
                onMarkPaid({
                  cycleId,
                  companyName,
                  finalFocus: rowMenuTriggerRef,
                })
              }
            >
              {tActions('markPaid')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
