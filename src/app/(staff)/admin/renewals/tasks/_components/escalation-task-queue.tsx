/**
 * F8 Phase 8 T219 — `<EscalationTaskQueue>` client component.
 *
 * Renders the admin escalation-task queue with Done / Skip / Reassign
 * actions per row. Manager-role rows render WITHOUT the action column —
 * the parent server page allows manager `read`, but mutating actions
 * (FR-052a) are admin-only.
 *
 * Features:
 *   - Status tabs (Open / Done / Skipped) — default Open
 *   - Per-user-tray filter ("All" | "Mine" | "Unassigned")
 *   - Task-type filter (dropdown over distinct types in the page)
 *   - Overdue >3d highlighting + queue-top banner
 *   - Action dialogs (Done / Skip / Reassign) → POST → router.refresh()
 *   - Mobile (<md): action buttons collapse to DropdownMenu (I-15)
 *   - Locale-aware date formatting via next-intl `useFormatter` (I-16)
 *   - Localised toast error descriptions per error-code map (I-5)
 *
 * Action dialogs live in sibling files:
 *   - DoneTaskDialog (T221)
 *   - SkipTaskDialog (T221)
 *   - ReassignTaskDropdown (T222)
 */
'use client';

import Link from 'next/link';
import { useId, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ClipboardCheck,
  Info,
  MoreHorizontal,
} from 'lucide-react';
import { mergeRefs } from '@/lib/merge-refs';
import { useDialogFinalFocus } from '@/components/broadcast/reason-confirmation-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  TranslatedSelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DoneTaskDialog } from './done-task-dialog';
import { SkipTaskDialog } from './skip-task-dialog';
import { ReassignTaskDropdown } from './reassign-task-dropdown';
import { StatusTablist, STATUS_TABS, type StatusTab } from './status-tablist';
import { selectActionErrorKey } from './describe-error';
import { resolveTaskTypeLabel } from './resolve-task-type-label';
import { YearInCyclePill } from '../../_components/year-in-cycle-pill';

export interface EscalationTaskQueueItem {
  readonly taskId: string;
  readonly memberId: string;
  /**
   * E1 close — joined `members.company_name`. NULL only when the
   * member row was archived AFTER task creation (LEFT JOIN preserves
   * the task even if the member is gone).
   */
  readonly memberCompanyName: string | null;
  /**
   * E1 close — joined `membership_plans.renewal_tier_bucket`. One of
   * `'thai_alumni' | 'start_up' | 'regular' | 'premium' | 'partnership'`
   * (FR-043 tier-bucket enum). NULL when the member's plan was deleted
   * or the tier-bucket column hasn't been backfilled.
   */
  readonly memberTierBucket: string | null;
  readonly cycleId: string | null;
  /**
   * E1 close — joined `renewal_cycles.expires_at`. Distinct from
   * `dueAt` (the task's own due date); spec AS1 mandates showing the
   * member's renewal expiry alongside the task.
   */
  readonly cycleExpiresAt: string | null;
  readonly taskType: string;
  readonly assignedToRole: 'admin' | 'manager' | 'executive_director';
  readonly assignedToUserId: string | null;
  /**
   * Round 5 I-13 + R8 IMP-F close — joined `users.display_name` for
   * the `assigned_to_user_id`. NULL when role-only or user deleted.
   * Required (`string | null`, not `?: ...`) so a future SSR
   * projection that forgets to map this field fails at compile time
   * — the prior optional shape silently let the page render UUID
   * slices when the field was omitted (Round 2 C-1 regression).
   */
  readonly assignedToDisplayName: string | null;
  /**
   * Round 5 I-13 + R8 IMP-F close — fallback display when
   * `display_name` is null. See above for required-vs-optional
   * rationale.
   */
  readonly assignedToEmail: string | null;
  readonly dueAt: string;
  readonly status: 'open' | 'done' | 'skipped';
  readonly createdAt: string;
  /**
   * Multi-year cycle context for the year-in-cycle pill (T220 / FR-043).
   * `yearInCycle: 1` + `totalYears: 1` collapses the pill to just the
   * task-type label (single-year contracts get no "Year 1 of 1" prefix).
   * R8 R4-IMP-5 close — required (was optional). The repo always
   * supplies these now (yearInCycle from new column DEFAULT 1;
   * totalYears computed from cycle_length_months). The prior optional
   * shape silently let the queue render single-year for ALL multi-
   * year contracts because the projection forgot to map them.
   */
  readonly yearInCycle: number;
  readonly totalYears: number;
}

export interface EscalationTaskQueueProps {
  /**
   * R6 IMP-11 close — narrowed from `'admin'|'manager'|'member'`. The
   * queue page redirects member to `/admin/renewals` so member-role
   * never reaches this component; including it widened the input
   * domain unnecessarily and created dead branches that obscured
   * `canMutate` intent.
   */
  readonly actorRole: 'admin' | 'manager';
  readonly actorUserId: string;
  readonly overdueCount: number;
  /**
   * UX-audit PR-A #2 — the distinct task-type list, derived by a SERVER
   * query over the whole tenant (scoped to the current status tab) rather
   * than computed from the fetched 50-row page. Drives both the task-type
   * filter control's option list AND its visibility gate (`length > 1`),
   * so the control is stable + complete regardless of which page is loaded.
   */
  readonly distinctTaskTypes: ReadonlyArray<string>;
  readonly items: ReadonlyArray<EscalationTaskQueueItem>;
}

type AssignmentFilter = 'all' | 'mine' | 'unassigned';

/**
 * UX-audit PR-A #4/#5 — an action dialog's launch target. `taskId` says which
 * task the confirm hits; `finalFocus` is the row's ⋯-trigger resolver so focus
 * returns there on cancel and falls back to `#main-content` when a Done/Skip
 * success unmounts the row (WCAG 2.1 AA SC 2.4.3). Bundling the resolver with
 * the target lets the single lifted dialog serve every row.
 */
interface DialogTarget {
  readonly taskId: string;
  readonly finalFocus: () => HTMLElement | null;
}

// Radix/Base UI `Select` FORBIDS an empty-string `SelectItem` value (it
// throws), but `taskTypeFilter` is `''` for "all types" (mirrors the
// `?task_type=` URL param being absent). `ALL` is the Select-only
// sentinel: mapped to `''`/`null` at the read/write boundary below, the
// same pattern as `../../_components/tier-filter-select.tsx`.
const ALL = 'all' as const;

const OVERDUE_HIGHLIGHT_DAYS = 3;
const OVERDUE_HIGHLIGHT_MS = OVERDUE_HIGHLIGHT_DAYS * 24 * 60 * 60 * 1000;

/**
 * Round 5 I-5 close — known API error codes mapped to localised toast
 * descriptions. Anything not in this set falls through to the generic
 * `unknown` key so admins see human copy instead of raw `task_not_open`.
 *
 * R6 IMP-3 close — split into wire-format (returned by API) vs client-
 * synthetic (`offline` is generated locally from a TypeError, never
 * sent by the server) so a hostile / drifted API response containing
 * `{error:{code:'offline'}}` is treated as `unknown` rather than
 * masquerading as the local "you appear to be offline" copy.
 *
 * R6 IMP-8 close — typed const tuple + type-guard so `safeCode`
 * narrows to the literal union for downstream key-template safety
 * (instead of widening to `string` via `as Set<string>`).
 */
// R10 S11 close — WIRE_ERROR_CODES + isWireErrorCode + the pure
// `selectActionErrorKey` dispatcher were extracted to sibling
// `describe-error.ts` so the 8 wire codes × 3 actions × forbidden-
// override branch can be exercised by Vitest without rendering the
// component. The component imports the dispatcher directly.

// R8 IMP-D close — STATUS_TABS + StatusTab + StatusTablist extracted
// to sibling `status-tablist.tsx` for unit-testability.

export function EscalationTaskQueue({
  actorRole,
  actorUserId,
  overdueCount,
  distinctTaskTypes,
  items,
}: EscalationTaskQueueProps) {
  const t = useTranslations('admin.renewals.tasks');
  const format = useFormatter();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  // UX-audit PR-A #4/#5 — the three lifted dialogs now carry a DialogTarget
  // ({taskId, finalFocus}) instead of a bare taskId, so each one can return
  // focus to the launching row's ⋯ trigger.
  const [doneDialogTarget, setDoneDialogTarget] = useState<DialogTarget | null>(
    null,
  );
  const [skipDialogTarget, setSkipDialogTarget] = useState<DialogTarget | null>(
    null,
  );
  const [reassignDialogTarget, setReassignDialogTarget] =
    useState<DialogTarget | null>(null);
  // UX-audit PR-A #5a — raised by postAction when a Done/Skip succeeds (the
  // row then unmounts on refresh). Read by each row's useDialogFinalFocus so
  // the resolver skips the about-to-unmount ⋯ trigger and lands on
  // #main-content instead of dropping focus to <body>.
  const closedViaSuccessRef = useRef(false);
  // useId() per-instance, mirroring `TierFilterSelect` — guarantees
  // uniqueness if this component is ever rendered twice on one page.
  const taskTypeFilterLabelId = `task-type-filter-label-${useId()}`;

  // Filters live in URL search params so the back button + sharing
  // works. Defaults: status='open', assignment='all'.
  // R8 R4-IMP-3 close — narrow status to StatusTab via whitelist so
  // `<StatusTablist status={status} />` has the tightened type.
  const statusRaw = searchParams.get('status');
  const status: StatusTab = (STATUS_TABS as readonly string[]).includes(
    statusRaw ?? '',
  )
    ? (statusRaw as StatusTab)
    : 'open';
  const assignmentRaw = searchParams.get('assignment');
  const assignment: AssignmentFilter =
    assignmentRaw === 'mine' || assignmentRaw === 'unassigned'
      ? assignmentRaw
      : 'all';
  const taskTypeFilter = searchParams.get('task_type') ?? '';
  const overdueOnly =
    searchParams.get('overdue_only') === 'true' ||
    searchParams.get('overdue_only') === '1';

  const now = Date.now();

  // Server already filtered by status/assignment/overdue/task_type (see
  // page.tsx). We keep a client-side re-filter for assignment/overdue only,
  // to guard the brief window of URL drift between SSR and a client
  // navigation transition. UX-audit PR-A #2 — task_type is now FULLY
  // server-side (shared buildListWhereExpr); the redundant client re-filter
  // over the fetched 50 was removed (it made the count lie + gated the
  // control on the current page's contents).
  const filteredItems = useMemo(() => {
    return items.filter((task) => {
      if (assignment === 'mine' && task.assignedToUserId !== actorUserId) {
        return false;
      }
      if (assignment === 'unassigned' && task.assignedToUserId !== null) {
        return false;
      }
      if (overdueOnly) {
        const dueMs = Date.parse(task.dueAt);
        if (
          !Number.isFinite(dueMs) ||
          dueMs >= now - OVERDUE_HIGHLIGHT_MS
        ) {
          return false;
        }
      }
      return true;
    });
  }, [items, assignment, overdueOnly, actorUserId, now]);

  function setSearchParam(name: string, value: string | null): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === '') {
      params.delete(name);
    } else {
      params.set(name, value);
    }
    // UX-audit PR-A #1 — any filter change restarts keyset pagination. A stale
    // `cursor` from a prior "Next 50" would otherwise be decoded under the new
    // filter set and skip/duplicate rows (the pipeline resets it the same way
    // on tab/tier/lens change). `cursor` is only ever set by the footer link.
    params.delete('cursor');
    const qs = params.toString();
    startTransition(() => router.replace(qs.length > 0 ? `?${qs}` : '?'));
  }

  /**
   * Round 5 I-5 close — map known error codes to localised description
   * keys. Unknown codes fall through to the `unknown` key so admins
   * always see human copy.
   *
   * R6 IMP-3 close — only WIRE codes (from API responses) are
   * filtered through `isWireErrorCode`. CLIENT codes (`'offline'`)
   * are passed in directly by the catch handler — never trusted from
   * a remote source.
   *
   * R8 HV-4 + R8 IMP-J close — i18n consolidation: 9 of 10 error
   * codes have byte-identical copy across actions; only `forbidden`
   * varies. Shared `actions.errors.<code>` namespace + per-action
   * `forbidden` override. Net -18 unique key paths (was 30 per
   * locale × 3 = 90 entries → 12 per locale × 3 = 36 entries).
   *
   * R8 S-1 close — inlined `safeWireCode` (the previous helper had
   * exactly two call sites and added a separation that didn't
   * survive the consolidation).
   */
  function describeError(
    action: 'done' | 'skip' | 'reassign',
    rawCode: string,
  ): string {
    // R10 S11 close — dispatcher logic moved to `describe-error.ts`
    // for unit-testability. The component just resolves the returned
    // i18n key through `t(...)`.
    return t(selectActionErrorKey(action, rawCode));
  }

  async function postAction(
    taskId: string,
    action: 'done' | 'skip' | 'reassign',
    body: Record<string, unknown>,
  ): Promise<boolean> {
    setPendingTaskId(taskId);
    try {
      const response = await fetch(
        `/api/admin/renewals/tasks/${taskId}/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        const errBody = await response
          .json()
          .catch(() => ({ error: { code: 'unknown' } }));
        const code: string = errBody?.error?.code ?? 'unknown';
        toast.error(t(`actions.${action}.error`), {
          description: describeError(action, code),
        });
        return false;
      }
      toast.success(t(`actions.${action}.success`));
      // UX-audit PR-A #5a — Done/Skip drops the task out of the Open tab on
      // refresh, so the launching row (and its ⋯ trigger) unmounts. Raise the
      // flag so each row's useDialogFinalFocus skips the vanishing trigger and
      // lands on #main-content.
      //
      // S1 follow-up — a reassign ALSO unmounts the row when an assignment
      // filter is active (?assignment=mine | unassigned | <colleague-uuid>):
      // the task leaves the active tray, router.refresh() re-queries, and the
      // row + its ⋯ trigger vanish → resolveDialogFinalFocus would return the
      // detached trigger node and focus drops to <body>. Raise the flag there
      // too so focus returns to #main-content instead (WCAG 2.4.3). Under
      // ?assignment=all a reassign KEEPS the row, so leave the flag false and
      // let focus return to the surviving ⋯ trigger. Read the RAW param —
      // the client-side `assignment` var collapses a ?assignment=<uuid>
      // colleague tray to 'all', which would miss that case.
      if (action === 'done' || action === 'skip') {
        closedViaSuccessRef.current = true;
      } else if (
        action === 'reassign' &&
        assignmentRaw !== null &&
        assignmentRaw !== 'all'
      ) {
        closedViaSuccessRef.current = true;
      }
      startTransition(() => router.refresh());
      return true;
    } catch (e) {
      // Browsers (Chromium/Firefox/Safari) all surface offline as a
      // TypeError with messages matching `/failed to fetch|
      // networkerror|load failed/i`; one regex covers all three. The
      // `offline` literal is a CLIENT-synthetic code (R6 IMP-3) — it
      // is never sent by the server, so it can be passed directly to
      // describeError without re-validating against WIRE codes.
      const isOffline =
        e instanceof TypeError &&
        /(failed to fetch|networkerror|load failed)/i.test(e.message);
      toast.error(t(`actions.${action}.error`), {
        description: describeError(action, isOffline ? 'offline' : 'unknown'),
      });
      return false;
    } finally {
      setPendingTaskId(null);
    }
  }

  const reassigningTask =
    reassignDialogTarget !== null
      ? items.find((task) => task.taskId === reassignDialogTarget.taskId) ?? null
      : null;
  const canMutate = actorRole === 'admin';

  // UX-audit PR-A #5a — opening any dialog resets the success flag so a plain
  // Cancel returns focus to the ⋯ trigger (not #main-content). postAction
  // re-raises it on a Done/Skip success just before the row unmounts.
  const openDoneDialog = (target: DialogTarget): void => {
    closedViaSuccessRef.current = false;
    setDoneDialogTarget(target);
  };
  const openSkipDialog = (target: DialogTarget): void => {
    closedViaSuccessRef.current = false;
    setSkipDialogTarget(target);
  };
  const openReassignDialog = (target: DialogTarget): void => {
    closedViaSuccessRef.current = false;
    setReassignDialogTarget(target);
  };

  /**
   * Round 5 I-13 close — render assignee display name (joined from
   * `users.display_name`) instead of raw 8-char UUID slice. Falls back
   * to email if display_name is null, then to the role-pill (when no
   * user is assigned at all).
   */
  function renderAssigneeCell(task: EscalationTaskQueueItem): React.ReactNode {
    if (task.assignedToUserId === null) {
      return (
        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
          {t(`assigneeRole.${task.assignedToRole}`)}
        </span>
      );
    }
    const display =
      task.assignedToDisplayName ??
      task.assignedToEmail ??
      task.assignedToUserId.slice(0, 8);
    return (
      <span
        className="truncate"
        title={task.assignedToEmail ?? task.assignedToUserId}
      >
        {display}
      </span>
    );
  }

  /**
   * Round 5 I-16 + R6 IMP-18 close — locale-aware date formatting via
   * next-intl. The formatter respects the active locale; SV renders
   * Swedish-locale dates (e.g. "1 jan. 2026").
   *
   * **TH BE caveat**: `Intl.DateTimeFormat('th-TH')` renders Gregorian
   * years by default. To get Thai Buddhist Era (BE = CE + 543 — e.g.
   * "1 ม.ค. 2569") the locale must include the unicode-extension
   * `-u-ca-buddhist`. Whether this happens depends on
   * `src/i18n/config.ts` — if not configured, TH users see Gregorian
   * years which is acceptable for short-form dates per CLAUDE.md
   * "Buddhist Era display-only for `th-TH` user-facing surfaces"
   * (the rule applies to long-form dates and tax documents; short
   * date column cells render either calendar legibly).
   *
   * Bad input falls back to em-dash.
   */
  function formatShortDate(iso: string): React.ReactNode {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) {
      return <span className="text-xs text-muted-foreground">—</span>;
    }
    return format.dateTime(new Date(ms), 'dateMedium');
  }

  return (
    <>
      {/* Round 5 I-19 close — manager-role banner so the absence of
          the actions column has an explicit explanation.
          R10 S3 close — `role="note"` semantic landmark for the
          informational banner (ARIA role for supplementary content). */}
      {!canMutate && (
        <div
          role="note"
          className="mb-3 flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground"
        >
          <Info className="size-4 shrink-0" aria-hidden />
          <span>{t('manager_read_only_notice')}</span>
        </div>
      )}

      {/* R6 UX-I-1 close — aria-live span stays mounted ALWAYS so
          AT only re-announces when text content changes (count
          changes), not every time the visible banner mounts/unmounts.
          The visible banner still appears only when overdueCount > 0
          and status === 'open', but the announcement region is stable
          DOM throughout the page lifecycle.
          Round 5 C-5 close (preserved) — `aria-live` was previously
          on the `<button>`, which is invalid ARIA. Live regions must
          be non-interactive containers. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {overdueCount > 0 && status === 'open'
          ? t('overdue_banner', { count: overdueCount })
          : ''}
      </span>
      {overdueCount > 0 && status === 'open' && (
        <>
          <button
            type="button"
            className="mb-4 flex w-full items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-left transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
            aria-pressed={overdueOnly}
            onClick={() =>
              setSearchParam('overdue_only', overdueOnly ? null : 'true')
            }
          >
            <AlertTriangle
              className="mt-0.5 size-5 shrink-0 text-destructive"
              aria-hidden
            />
            <div className="flex-1">
              <p className="text-sm font-medium text-destructive">
                {t('overdue_banner', { count: overdueCount })}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(overdueOnly ? 'overdue_banner_clear' : 'overdue_banner_cta')}
              </p>
            </div>
          </button>
        </>
      )}
      {/* End R6 UX-I-1 banner block. */}

      {/* Filter chips */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Round 5 I-20 close — proper ARIA tab pattern: parent
            role="tablist" + each child role="tab" with aria-controls
            pointing at the panel id below.
            R6 C-5 close — Arrow-key navigation + roving-tabIndex per
            ARIA APG tablist composite-widget pattern (WCAG 2.1
            SC 4.1.2). Selected tab has tabIndex=0 (Tab into group);
            others have tabIndex=-1 (Arrow-keys move focus, Tab exits
            the group). */}
        <StatusTablist
          status={status}
          t={t}
          onSelect={(s) => setSearchParam('status', s)}
        />
        {/* R6 IMP-16 close — was incorrectly using `assignment_tab.all`
            (the FIRST OPTION's label "All") as the GROUP's label, so
            screen readers announced "All group". Use a dedicated
            group label key. */}
        <div
          className="flex gap-1"
          role="group"
          aria-label={t('assignment_filter_aria')}
        >
          {(['all', 'mine', 'unassigned'] as const).map((a) => (
            <Button
              key={a}
              size="sm"
              variant={assignment === a ? 'secondary' : 'ghost'}
              aria-pressed={assignment === a}
              onClick={() =>
                setSearchParam('assignment', a === 'all' ? null : a)
              }
            >
              {t(`assignment_tab.${a}`)}
            </Button>
          ))}
        </div>
        {distinctTaskTypes.length > 1 && (
          // Use aria-labelledby + a visually-hidden label, not
          // aria-label — see `TierFilterSelect`'s identical comment:
          // aria-label would replace the trigger's accessible NAME,
          // losing the paired name+value announcement (WCAG 4.1.2).
          <div className="w-full sm:w-[14rem] ml-auto">
            <span id={taskTypeFilterLabelId} className="sr-only">
              {t('task_type_filter_aria')}
            </span>
            <Select
              value={taskTypeFilter === '' ? ALL : taskTypeFilter}
              onValueChange={(v) =>
                setSearchParam('task_type', v === ALL ? null : v)
              }
            >
              <SelectTrigger
                aria-labelledby={taskTypeFilterLabelId}
                className="w-full"
              >
                <TranslatedSelectValue
                  translate={(value) =>
                    !value || value === ALL
                      ? t('task_type_filter_all')
                      : resolveTaskTypeLabel(t, value)
                  }
                />
              </SelectTrigger>
              {/* `align="end"` anchors the popup to the trigger's
                  right edge — this trigger sits on the right side of
                  the filter row (mirrors TierFilterSelect). */}
              <SelectContent align="end">
                <SelectItem value={ALL}>
                  {t('task_type_filter_all')}
                </SelectItem>
                {distinctTaskTypes.map((tt) => (
                  <SelectItem key={tt} value={tt}>
                    {resolveTaskTypeLabel(t, tt)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div
        id="escalation-tasks-tabpanel"
        role="tabpanel"
        // R8 IMP-H close — APG-recommended `aria-labelledby` referencing
        // the controlling tab's id (ids assigned by StatusTablist).
        aria-labelledby={`task-status-tab-${status}`}
      >
        {filteredItems.length === 0 ? (
          // E3 close — distinct copy for "no tasks at all" vs "filter
          // returned no rows". Round 5 I-17 close — added empty-state
          // icon (ux-standards § 3.1).
          (() => {
            const isFilterActive =
              assignment !== 'all' ||
              taskTypeFilter !== '' ||
              overdueOnly ||
              status !== 'open';
            const stateKey = isFilterActive
              ? 'filter_active_state'
              : 'empty_state';
            return (
              // R8 R4-IMP-6 close — `role="status"` was semantically
              // incorrect on static markup (implies aria-live="polite"
              // for dynamic content). The parent `role="tabpanel"`
              // already provides AT announcement when entering the
              // panel; the static empty-state markup needs no explicit
              // status role.
              <div className="py-12 text-center">
                <ClipboardCheck
                  className="mx-auto mb-3 size-12 text-muted-foreground"
                  aria-hidden
                />
                <p className="text-base text-muted-foreground">
                  {t(`${stateKey}.title`)}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t(`${stateKey}.subtitle`)}
                </p>
                {!isFilterActive && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-4"
                    onClick={() => setSearchParam('status', 'done')}
                  >
                    {t('empty_state.cta_history')}
                  </Button>
                )}
              </div>
            );
          })()
        ) : (
          // Enterprise-ux review fix — `overflow-x-auto` on this wrapper
          // (not just the inner `<Table>`'s own scroll container) gives
          // the browser a bounded box whose automatic min-size is 0 in
          // the surrounding flex/grid layout, so the 8-column table
          // scrolls WITHIN this box on tablet/mobile instead of forcing
          // the page body to scroll horizontally (docs/ux-standards.md —
          // wide content must scroll in its own box). Mirrors
          // `admin/invoices/_components/invoice-table.tsx`'s scroll
          // wrapper.
          <div className="overflow-x-auto rounded-md border">
            <Table>
              {/* R10 S1 close — sr-only caption for richer AT context. */}
              <TableCaption className="sr-only">
                {t('table_caption')}
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.member')}</TableHead>
                  <TableHead>{t('columns.tier')}</TableHead>
                  <TableHead>{t('columns.expiresAt')}</TableHead>
                  <TableHead>{t('columns.taskType')}</TableHead>
                  <TableHead>{t('columns.dueAt')}</TableHead>
                  <TableHead>{t('columns.assignedTo')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  {canMutate && (
                    <TableHead className="text-right">
                      {t('columns.actions')}
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((task) => {
                  const dueMs = Date.parse(task.dueAt);
                  const isOverdue =
                    task.status === 'open' &&
                    Number.isFinite(dueMs) &&
                    dueMs < now - OVERDUE_HIGHLIGHT_MS;
                  const isOpen = task.status === 'open';
                  const busy = pendingTaskId === task.taskId;
                  return (
                    <TableRow
                      key={task.taskId}
                      aria-busy={busy}
                      className={
                        isOverdue
                          ? 'bg-destructive/5 ring-1 ring-destructive/30'
                          : undefined
                      }
                    >
                      <TableCell className="align-top">
                        {/* Table-wrap fix — a long company name (e.g.
                            "SCANIA SIAM COMPANY LIMITED") used to run
                            on one line and jam against "View timeline".
                            `whitespace-normal` overrides TableCell's
                            default `whitespace-nowrap`; the name clamps
                            to 2 lines (`line-clamp-2` + `break-words`
                            for a single unbroken long token) within a
                            `max-w` bound so wrapping actually triggers.
                            "View timeline" moves to its own line below
                            the (now up-to-2-line) name. */}
                        <div className="max-w-[26ch] whitespace-normal">
                          <Link
                            href={`/admin/members/${task.memberId}`}
                            // Enterprise-ux review fix — explicit
                            // outline-based focus ring (matches sibling
                            // renewals links, e.g. `[cycleId]/page.tsx`,
                            // `members-without-cycle-tray.tsx`). Outline
                            // (unlike a box-shadow `ring`) is not clipped
                            // by this element's own `overflow: hidden`
                            // from `line-clamp-2`, so keyboard focus
                            // stays fully visible on wrapped 2-line rows.
                            className="line-clamp-2 break-words rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                            title={task.memberCompanyName ?? undefined}
                          >
                            {task.memberCompanyName ?? (
                              <span className="font-mono text-xs">
                                {task.memberId.slice(0, 8)}
                              </span>
                            )}
                          </Link>
                          {/* SF-3 close — Timeline jump-link sub-action
                              (smart-chamber feature #6).
                              R6 UX-I-4 close — disambiguating aria-label
                              so each row's timeline link has a unique
                              announcement when SR users tab through the
                              queue. */}
                          <Link
                            href={`/admin/members/${task.memberId}/timeline`}
                            className="mt-0.5 block text-xs text-muted-foreground hover:text-foreground hover:underline"
                            aria-label={t('view_timeline_for', {
                              company:
                                task.memberCompanyName ?? task.memberId,
                            })}
                          >
                            {t('view_timeline')}
                          </Link>
                          {/* Member-id always available to AT for
                              unambiguous identification when names collide. */}
                          <span className="sr-only"> · {task.memberId}</span>
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        {task.memberTierBucket !== null ? (
                          <span className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-xs font-medium text-secondary-foreground">
                            {t(`tierBucket.${task.memberTierBucket}`)}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        {task.cycleExpiresAt !== null ? (
                          <time
                            dateTime={task.cycleExpiresAt}
                            className="text-sm"
                          >
                            {formatShortDate(task.cycleExpiresAt)}
                          </time>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-top">
                        {/* Table-wrap fix — long task-type labels wrap
                            (e.g. "Termination deferred - no statutory
                            warning ≥14 days" at 59 chars) instead of
                            forcing the row wider / overflowing. Unlike the
                            Member column (arbitrary company names → CLAMPED
                            to 2 lines), task-type is a FIXED i18n enum whose
                            longest value is a critical LEGAL status, so it
                            wraps FULLY — NO line-clamp — because clipping it
                            would hide the load-bearing qualifier; only the
                            rare termination rows grow taller, and those are
                            high-stakes rows that should read in full (this
                            also removes the touch-a11y gap the 2-line clip
                            had, where the clipped tail was reachable only via
                            title/aria). Enterprise-ux review fix: the width
                            cap sits on the pill's LABEL SPAN via
                            `labelClassName` (not the cell), so the fixed-
                            width "Year N of M" chip renders at its natural
                            width on one line and only the label wraps within
                            `max-w-[22ch]`. `whitespace-normal` overrides
                            TableCell's default `whitespace-nowrap` so the
                            label can wrap at all. */}
                        <div className="whitespace-normal">
                          <YearInCyclePill
                            yearInCycle={task.yearInCycle}
                            totalYears={task.totalYears}
                            taskTypeLabel={resolveTaskTypeLabel(t, task.taskType)}
                            labelClassName="break-words min-w-0 max-w-[22ch]"
                          />
                        </div>
                      </TableCell>
                      <TableCell className="align-top">
                        <time dateTime={task.dueAt}>
                          {formatShortDate(task.dueAt)}
                        </time>
                        {isOverdue && (
                          <span className="ml-2 rounded-full bg-destructive-surface px-1.5 py-0.5 text-xs font-medium text-destructive">
                            {t('overdue_badge')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="align-top text-xs">
                        {renderAssigneeCell(task)}
                      </TableCell>
                      <TableCell className="align-top">
                        <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">
                          {t(`status.${task.status}`)}
                        </span>
                      </TableCell>
                      {canMutate && (
                        <TableCell className="align-top text-right">
                          {/* UX-audit PR-A #4 — one visible primary (Done) +
                              the ⋯ overflow menu (Skip / Reassign) at ALL
                              breakpoints. Previously the row rendered THREE
                              full-width buttons on desktop (up to 150 competing
                              buttons on a 50-row table) and only collapsed to a
                              menu below md; this applies the /admin "one
                              primary + ⋯ overflow" convention everywhere. */}
                          <TaskRowActions
                            task={task}
                            isOpen={isOpen}
                            busy={busy}
                            t={t}
                            closedViaSuccessRef={closedViaSuccessRef}
                            onDone={openDoneDialog}
                            onSkip={openSkipDialog}
                            onReassign={openReassignDialog}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Action dialogs. Only one open at a time. UX-audit PR-A #5a — each
          receives the launching row's `finalFocus` resolver so focus returns
          to the ⋯ trigger on cancel (and #main-content when a Done/Skip
          success unmounts the row). */}
      <DoneTaskDialog
        open={doneDialogTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDoneDialogTarget(null);
        }}
        finalFocus={doneDialogTarget?.finalFocus}
        onSubmit={async (note) => {
          if (doneDialogTarget === null) return;
          const ok = await postAction(doneDialogTarget.taskId, 'done', {
            outcome_note: note,
          });
          if (ok) setDoneDialogTarget(null);
        }}
      />

      <SkipTaskDialog
        open={skipDialogTarget !== null}
        onOpenChange={(next) => {
          if (!next) setSkipDialogTarget(null);
        }}
        finalFocus={skipDialogTarget?.finalFocus}
        onSubmit={async (reason) => {
          if (skipDialogTarget === null) return;
          const ok = await postAction(skipDialogTarget.taskId, 'skip', {
            skipped_reason: reason,
          });
          if (ok) setSkipDialogTarget(null);
        }}
      />

      <ReassignTaskDropdown
        open={reassignDialogTarget !== null}
        onOpenChange={(next) => {
          if (!next) setReassignDialogTarget(null);
        }}
        finalFocus={reassignDialogTarget?.finalFocus}
        currentAssigneeUserId={reassigningTask?.assignedToUserId ?? null}
        onSubmit={async (toUserId) => {
          if (reassignDialogTarget === null) return;
          const ok = await postAction(reassignDialogTarget.taskId, 'reassign', {
            to_user_id: toUserId,
          });
          if (ok) setReassignDialogTarget(null);
        }}
      />
    </>
  );
}

/**
 * UX-audit PR-A #4/#5 — per-row action cluster: one visible primary (Done) +
 * a ⋯ overflow menu carrying Skip + Reassign, at ALL breakpoints. Split out of
 * the row map so it can own the persistent ⋯-trigger ref + the
 * `useDialogFinalFocus` resolver (hooks can't live in a `.map()` callback).
 * Reuses the mobile-menu markup the queue already shipped; Done is promoted to
 * a visible button and the menu keeps Skip/Reassign. Admin-gated by the caller
 * (`canMutate`), exactly as before.
 */
function TaskRowActions({
  task,
  isOpen,
  busy,
  t,
  closedViaSuccessRef,
  onDone,
  onSkip,
  onReassign,
}: {
  readonly task: EscalationTaskQueueItem;
  readonly isOpen: boolean;
  readonly busy: boolean;
  readonly t: ReturnType<typeof useTranslations<'admin.renewals.tasks'>>;
  readonly closedViaSuccessRef: React.RefObject<boolean>;
  readonly onDone: (target: DialogTarget) => void;
  readonly onSkip: (target: DialogTarget) => void;
  readonly onReassign: (target: DialogTarget) => void;
}) {
  // Persistent ref to this row's ⋯ trigger — merged (NOT overridden) into Base
  // UI's own DropdownMenuTrigger ref: a bare `ref=` on the render-prop element
  // replaces Base UI's ref and the Positioner loses its anchor (the menu stops
  // opening). See `mergeRefs` + the pipeline `RowActions` precedent.
  const rowMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Resolver handed to all three dialogs as `finalFocus`: returns the ⋯ trigger
  // on cancel, but when `closedViaSuccessRef` is raised (Done/Skip success →
  // row unmounts) it skips the vanishing trigger and lands on #main-content.
  const finalFocus = useDialogFinalFocus(
    rowMenuTriggerRef,
    undefined,
    closedViaSuccessRef,
  );
  return (
    <div className="flex items-center justify-end gap-2">
      <Button
        // N1 — h-9 (`size="default"`) so this visible primary aligns with the
        // pipeline's primary height and the 44px ⋯ trigger beside it, instead
        // of the cramped h-7 `size="sm"`.
        size="default"
        variant="default"
        disabled={!isOpen || busy}
        aria-busy={busy}
        onClick={() => onDone({ taskId: task.taskId, finalFocus })}
      >
        {t('actions.done.label')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={({ ref: baseRef, ...props }) => (
            <Button
              {...props}
              ref={mergeRefs(baseRef, rowMenuTriggerRef)}
              // N2 — `size="icon"` for idiom parity with the pipeline
              // RowActions trigger (row-actions.tsx:289); `h-11 w-11` still
              // overrides to the 44px target below.
              size="icon"
              variant="ghost"
              // 44×44 tap target (WCAG 2.5.5 / iOS HIG) — an icon-only trigger
              // in a dense table where a mis-tap routes to the wrong row.
              className="h-11 w-11"
              disabled={!isOpen || busy}
              aria-busy={busy}
              // S3 — per-row accessible name so SR users tabbing the 50-row
              // queue know WHICH member's task they're about to Skip/Reassign
              // (this ⋯ menu is now the ONLY path to those actions at every
              // breakpoint). Mirrors the pipeline RowActions gold standard
              // (row-actions.tsx:296,303): `aria-label` for AT (wins over the
              // icon content) + native `title` for the sighted-mouse tooltip.
              aria-label={t('actions.row_menu_for', {
                company: task.memberCompanyName ?? task.memberId,
              })}
              title={t('actions.row_menu_for', {
                company: task.memberCompanyName ?? task.memberId,
              })}
            >
              <MoreHorizontal className="size-4" aria-hidden />
            </Button>
          )}
        />
        {/*
         * S2 — `min-w-56 whitespace-nowrap` per ux-standards § 19 (mirrors the
         * pipeline RowActions menu, row-actions.tsx:315). Without this the
         * dropdown's default `min-w-32` (128px) wraps the long Thai Reassign
         * label "เปลี่ยนผู้รับผิดชอบ" mid-word.
         */}
        <DropdownMenuContent align="end" className="min-w-56 whitespace-nowrap">
          <DropdownMenuItem
            onClick={() => onSkip({ taskId: task.taskId, finalFocus })}
          >
            {t('actions.skip.label')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onReassign({ taskId: task.taskId, finalFocus })}
          >
            {t('actions.reassign.label')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
