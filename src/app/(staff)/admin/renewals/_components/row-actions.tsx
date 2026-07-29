'use client';

/**
 * Task 12 review round 1 (FIX 1) — `RowActions` + `PipelineEmptyMessage`,
 * extracted OUT of `pipeline-table.tsx` to break a circular import.
 *
 * Before this file existed: `pipeline-table.tsx` imported `PipelineCardList`
 * (to render the mobile card-stack — see that component's docstring), and
 * `pipeline-card-list.tsx` imported `RowActions` + `PipelineEmptyMessage` +
 * the `OutreachTarget`/`MarkPaidTarget` types back FROM `pipeline-table.tsx`
 * — a 2-module cycle (untested under Turbopack). Both `pipeline-table.tsx`
 * and `pipeline-card-list.tsx` now import these from THIS module instead:
 * `pipeline-table.tsx` imports `PipelineCardList` one-way, and this module
 * has no dependency on either of them — the cycle is gone by construction.
 *
 * Everything below is moved VERBATIM out of `pipeline-table.tsx` (same
 * house precedent as `060-member-portal-d4`'s `PortalInvoiceCardList`,
 * which sources its shared row bits from separate modules, never a cycle) —
 * behavior is byte-identical; see git history / `pipeline-table.tsx`'s own
 * review-round comments for the context behind each piece.
 */
import { useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Loader2Icon, MoreHorizontal } from 'lucide-react';
import { mergeRefs } from '@/lib/merge-refs';
import { shouldOfferMarkPaid } from '../_lib/mark-paid-gate';
// Client-safe sub-barrel — see `tier-filter-select.tsx` for the
// rationale (Turbopack 16 + F8 barrel + server-only deps).
import type { CycleStatus } from '@/modules/renewals/client';

/**
 * Task 12 — shared shape for the lifted "Record outreach" dialog target.
 * Exported so `PipelineCardList` can type its `onRecordOutreach` prop
 * identically to `RowActions`' own callback without re-declaring the
 * shape (both ultimately feed the SAME `setOutreachFor` state in
 * `PipelineTable`).
 */
export interface OutreachTarget {
  readonly memberId: string;
  readonly companyName: string;
  readonly finalFocus: React.RefObject<HTMLElement | null>;
}

/** Task 12 — same rationale as {@link OutreachTarget}, for "Mark paid". */
export interface MarkPaidTarget {
  readonly cycleId: string;
  readonly companyName: string;
  readonly finalFocus: React.RefObject<HTMLElement | null>;
}

/**
 * Task 12 — the "no rows in this bucket" copy, extracted verbatim out of
 * the `<table>`'s empty `<TableCell>` (was inline JSX there) so
 * `PipelineCardList`'s own empty state renders the EXACT same
 * month-lens-aware copy without re-deriving the `monthKind`/`monthLabel`
 * branching a second time. Pure text — no table-specific markup — so it
 * drops into either presentation's empty-state container unchanged.
 */
export function PipelineEmptyMessage({
  monthKind,
  monthLabel,
}: {
  readonly monthKind?: 'overdue' | 'later' | 'month';
  readonly monthLabel?: string;
}): React.JSX.Element {
  const t = useTranslations('admin.renewals.table');
  if (monthKind === 'overdue') {
    return (
      <p className="text-sm font-medium text-foreground">{t('noRowsOverdue')}</p>
    );
  }
  if (monthKind === 'later' && monthLabel !== undefined) {
    return (
      <p className="text-sm font-medium text-foreground">
        {t('noRowsLater', { month: monthLabel })}
      </p>
    );
  }
  if ((monthKind === 'month' || monthKind === undefined) && monthLabel !== undefined) {
    return (
      <p className="text-sm font-medium text-foreground">
        {t('noRowsInMonth', { month: monthLabel })}
      </p>
    );
  }
  return (
    <>
      <p className="text-sm font-medium text-foreground">{t('noRows')}</p>
      <p className="mt-1 text-xs">{t('noRowsInBucket')}</p>
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
 *
 * Fix round 3 — `canMutate` additionally gates "Send reminder" and "Mark
 * paid" (both admin-only at the route) to `false` for a read-only manager.
 * "Open" and "Mark contacted" are unconditional — see `pipeline-table.tsx`'s
 * module docstring.
 *
 * Task 12 — exported (from this module, since review round 1 — see the
 * module docstring above) so `PipelineCardList` can reuse this UNCHANGED
 * per card instead of re-implementing the ⋯ menu / send-reminder button /
 * finalFocus contract for the mobile presentation.
 */
export function RowActions({
  cycleId,
  memberId,
  companyName,
  status,
  canMutate,
  onRecordOutreach,
  onMarkPaid,
}: {
  readonly cycleId: string;
  readonly memberId: string;
  readonly companyName: string;
  readonly status: CycleStatus;
  readonly canMutate: boolean;
  readonly onRecordOutreach: (t: OutreachTarget) => void;
  readonly onMarkPaid: (t: MarkPaidTarget) => void;
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
          different concern than a wide labelled text button.

          Fix round 3 — admin-only (`canMutate`): the route 403s a manager,
          so this was a mint-a-403 CTA on a read-only surface. Not rendered
          at all for manager (vs disabled-with-tooltip) — matches F8's
          existing "absent, not disabled" convention for manager-blocked
          affordances (spec FR-052a / `docs/ux-standards.md`). */}
      {canMutate ? (
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
      ) : null}
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
              instead when a settlement's refresh unmounts this row.

              Fix round 3 — additionally admin-only (`canMutate`): mints a
              §86/4 tax invoice + completes the cycle (a money mutation),
              and the route 403s a manager — same mint-a-403 rationale as
              the "Send reminder" button above. */}
          {canMutate && shouldOfferMarkPaid(status) ? (
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
