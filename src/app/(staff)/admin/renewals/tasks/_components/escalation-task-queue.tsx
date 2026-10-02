/**
 * F8 Phase 8 T219 — `<EscalationTaskQueue>` client component.
 *
 * The admin escalation-task queue with Done / Skip / Reassign actions per row.
 * A manager reads the queue (the server page allows `read`); the mutating
 * actions (FR-052a) need `renewals.write`, passed in as `canMutate`.
 *
 * 122 US7b-2 (T731, T732), boards `Admin-renewal-tasks` (+`-mobile`) and
 * `Admin-state-tasks-manager`, on AURA:
 *   - the overdue toggle card, then a "Filter tasks" group: Status (Open, Done,
 *     Skipped) and Assignment (All, Mine, Unassigned) as pressed-button groups,
 *     then the Task type `Select`;
 *   - one `DataTable` that stacks into cards below 640px;
 *   - per open row, for someone who can act, "Done" plus a ⋯ menu (Skip,
 *     Reassign, View timeline) named for its row; a closed row, or a manager,
 *     gets a "View timeline" link instead, so the timeline stays one tap away
 *     for everyone (it moved out of the member cell).
 * Filters still live in the URL; the requests, error mapping and toasts are
 * unchanged (spec Clarifications, Session 2026-10-01 US7b-2 start).
 *
 * Action dialogs live in sibling files: DoneTaskDialog, SkipTaskDialog,
 * ReassignTaskDropdown.
 */
'use client';

import Link from 'next/link';
import { useCallback, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  DropdownMenu,
  IconButton,
  Select,
  StatusPill,
  Tag,
  buttonClass,
  type DataTableColumn,
  type MenuItem,
} from '@jirawatpyk/aura-react';
import { Check, CircleCheck, TriangleAlert } from 'lucide-react';
import { toast } from '@/lib/toast';
import { resolveDialogFinalFocus } from '@/components/broadcast/resolve-dialog-final-focus';
import { EmptyState } from '@/components/shell/empty-state';
import { TierBadge } from '@/components/renewals/tier-badge';
import { TIER_BUCKETS, type TierBucket } from '@/modules/renewals/client';
import { formatDatePreset } from '@/lib/format-date-localised';
import { DoneTaskDialog } from './done-task-dialog';
import { SkipTaskDialog } from './skip-task-dialog';
import { ReassignTaskDropdown } from './reassign-task-dropdown';
import { selectActionErrorKey } from './describe-error';
import { resolveTaskTypeLabel } from './resolve-task-type-label';
import { YearInCyclePill } from '../../_components/year-in-cycle-pill';
import { ESCALATION_TASK_COLUMN_LAYOUT } from './escalation-task-queue-columns';

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
   * projection that forgets to map this field fails at compile time.
   */
  readonly assignedToDisplayName: string | null;
  /** Round 5 I-13 + R8 IMP-F close — fallback display when `display_name` is null. */
  readonly assignedToEmail: string | null;
  readonly dueAt: string;
  readonly status: 'open' | 'done' | 'skipped';
  readonly createdAt: string;
  /**
   * Multi-year cycle context for the year-in-cycle pill (T220 / FR-043).
   * `yearInCycle: 1` + `totalYears: 1` collapses the pill to just the
   * task-type label. Required so a projection that forgets them fails to
   * compile (R8 R4-IMP-5).
   */
  readonly yearInCycle: number;
  readonly totalYears: number;
}

export interface EscalationTaskQueueProps {
  /**
   * 016 T033 — server-derived write authorization (`renewals.write`), so a
   * `super_admin` gets the actions too.
   */
  readonly canMutate: boolean;
  readonly actorUserId: string;
  readonly overdueCount: number;
  /**
   * UX-audit PR-A #2 — the distinct task types, from a SERVER query over the
   * whole tenant (scoped to the current status), not the fetched 50-row page.
   * Drives the Task type options and its visibility (`length > 1`).
   */
  readonly distinctTaskTypes: ReadonlyArray<string>;
  readonly items: ReadonlyArray<EscalationTaskQueueItem>;
}

export const STATUS_FILTERS = ['open', 'done', 'skipped'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];
const ASSIGNMENT_FILTERS = ['all', 'mine', 'unassigned'] as const;
type AssignmentFilter = (typeof ASSIGNMENT_FILTERS)[number];
type TaskAction = 'done' | 'skip' | 'reassign';
/**
 * The "All types" option's value. AURA draws an option whose value is '' in a
 * placeholder's grey, but "All types" is a real choice (board); it never
 * reaches the URL, which drops `task_type` for it. Task types are snake_case,
 * so no type can collide with it.
 */
const ALL_TASK_TYPES = '__all__';

const OVERDUE_HIGHLIGHT_DAYS = 3;
const OVERDUE_HIGHLIGHT_MS = OVERDUE_HIGHLIGHT_DAYS * 24 * 60 * 60 * 1000;

const STATUS_TONE = { open: 'progress', done: 'ready', skipped: 'neutral' } as const;

function isTierBucket(value: string | null): value is TierBucket {
  return value !== null && (TIER_BUCKETS as readonly string[]).includes(value);
}

/**
 * A group of AURA toggle chips, as the board draws Status and Assignment: each
 * chip says whether it is the current filter (`aria-pressed`, plus a check),
 * and pressing one loads that view. Not a tablist: activation is a press
 * (Enter, Space or a click), never an arrow key, because each choice reloads
 * the queue.
 */
function PressedGroup<V extends string>({
  label,
  options,
  value,
  onPress,
}: {
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: V; readonly label: string }>;
  readonly value: V | null;
  readonly onPress: (next: V) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex max-w-full flex-wrap gap-[var(--aura-space-2)]">
      {options.map((option) => (
        <Tag
          key={option.value}
          selected={option.value === value}
          onClick={() => onPress(option.value)}
          touchHeight
        >
          {option.label}
        </Tag>
      ))}
    </div>
  );
}

export function EscalationTaskQueue({
  canMutate,
  actorUserId,
  overdueCount,
  distinctTaskTypes,
  items,
}: EscalationTaskQueueProps) {
  const t = useTranslations('admin.renewals.tasks');
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  // One dialog at a time: which action, on which task.
  const [dialog, setDialog] = useState<{ action: TaskAction; taskId: string } | null>(null);

  // Focus return (WCAG 2.1 SC 2.4.3). `triggerRef` holds the control that
  // opened the dialog: the row's Done button, or its ⋯ button for an action
  // chosen from the menu (the menu item is gone with the menu).
  // `closedViaSuccessRef` is raised when the action succeeds: the row then
  // leaves the view on refresh, so focus goes to #main-content instead.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closedViaSuccessRef = useRef(false);
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const finalFocus = useCallback(
    (): HTMLElement | null =>
      resolveDialogFinalFocus({
        closedViaSuccess: closedViaSuccessRef.current,
        trigger: triggerRef.current,
        fallback: null,
        mainContent: typeof document !== 'undefined' ? document.getElementById('main-content') : null,
      }),
    [],
  );

  // Filters live in the URL so the back button and sharing work.
  const statusRaw = searchParams.get('status');
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(statusRaw ?? '')
    ? (statusRaw as StatusFilter)
    : 'open';
  // `assignment` can also carry a colleague's id (a shared link): then none of
  // the three buttons is pressed, and the server filters by that id.
  const assignmentRaw = searchParams.get('assignment');
  const assignmentPressed: AssignmentFilter | null =
    assignmentRaw === null || assignmentRaw === 'all'
      ? 'all'
      : assignmentRaw === 'mine' || assignmentRaw === 'unassigned'
        ? assignmentRaw
        : null;
  const assignment: AssignmentFilter = assignmentPressed ?? 'all';
  const taskTypeFilter = searchParams.get('task_type') ?? '';
  const overdueOnly =
    searchParams.get('overdue_only') === 'true' || searchParams.get('overdue_only') === '1';

  // Read once per mount: a fresh value on every render would rebuild the
  // columns each time.
  const [now] = useState(() => Date.now());

  // The server already filtered by status/assignment/overdue/task_type. A
  // client re-filter on assignment and overdue guards the brief URL drift
  // between SSR and a client transition (task_type is server-only, UX-audit #2).
  const filteredItems = useMemo(
    () =>
      items.filter((task) => {
        if (assignment === 'mine' && task.assignedToUserId !== actorUserId) return false;
        if (assignment === 'unassigned' && task.assignedToUserId !== null) return false;
        if (overdueOnly) {
          const dueMs = Date.parse(task.dueAt);
          if (!Number.isFinite(dueMs) || dueMs >= now - OVERDUE_HIGHLIGHT_MS) return false;
        }
        return true;
      }),
    [items, assignment, overdueOnly, actorUserId, now],
  );

  function setSearchParam(name: string, value: string | null): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === '') params.delete(name);
    else params.set(name, value);
    // UX-audit PR-A #1 — any filter change restarts keyset pagination.
    params.delete('cursor');
    const qs = params.toString();
    // Same-page filter → keep the scroll position.
    startTransition(() => router.replace(qs.length > 0 ? `?${qs}` : '?', { scroll: false }));
  }

  const postAction = useCallback(
    async (taskId: string, action: TaskAction, body: Record<string, unknown>): Promise<void> => {
      setPendingTaskId(taskId);
      closedViaSuccessRef.current = false;
      try {
        const response = await fetch(`/api/admin/renewals/tasks/${taskId}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({ error: { code: 'unknown' } }));
          const code: string = errBody?.error?.code ?? 'unknown';
          toast.error(t(`actions.${action}.error`), {
            description: t(selectActionErrorKey(action, code)),
          });
          return;
        }
        toast.success(t(`actions.${action}.success`));
        // Done/Skip drop the task out of the Open view on refresh, so its row
        // unmounts. A reassign does too under an assignment filter (the task
        // leaves the tray); read the RAW param, since a colleague's id
        // collapses to 'all' above. Under 'all' the row stays.
        if (action !== 'reassign' || (assignmentRaw !== null && assignmentRaw !== 'all')) {
          closedViaSuccessRef.current = true;
        }
        // A failed action leaves its dialog open, so the admin can retry.
        setDialog((d) => (d?.taskId === taskId ? null : d));
        startTransition(() => router.refresh());
      } catch (e) {
        // Chromium, Firefox and Safari surface offline as a TypeError with
        // one of these messages. `offline` is a client code, never sent by
        // the server (R6 IMP-3).
        const isOffline =
          e instanceof TypeError && /(failed to fetch|networkerror|load failed)/i.test(e.message);
        toast.error(t(`actions.${action}.error`), {
          description: t(selectActionErrorKey(action, isOffline ? 'offline' : 'unknown')),
        });
      } finally {
        setPendingTaskId((p) => (p === taskId ? null : p));
      }
    },
    [t, router, assignmentRaw],
  );

  const openDialog = useCallback((action: TaskAction, taskId: string, trigger: HTMLButtonElement | null) => {
    triggerRef.current = trigger;
    closedViaSuccessRef.current = false;
    setDialog({ action, taskId });
  }, []);

  const formatShortDate = useCallback(
    (iso: string): string | null => {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? formatDatePreset(new Date(ms), locale, 'dateMedium') : null;
    },
    [locale],
  );

  const columns = useMemo<DataTableColumn<EscalationTaskQueueItem>[]>(() => {
    const isOverdue = (task: EscalationTaskQueueItem) => {
      const dueMs = Date.parse(task.dueAt);
      return task.status === 'open' && Number.isFinite(dueMs) && dueMs < now - OVERDUE_HIGHLIGHT_MS;
    };
    const dash = <span className="text-xs text-[var(--aura-fg-secondary)]">—</span>;
    const assignee = (task: EscalationTaskQueueItem) =>
      task.assignedToUserId === null
        ? t('assignment_tab.unassigned')
        : (task.assignedToDisplayName ?? task.assignedToEmail ?? task.assignedToUserId.slice(0, 8));
    const role = (task: EscalationTaskQueueItem) => t(`assigneeRole.${task.assignedToRole}`);
    const taskTypeLabel = (task: EscalationTaskQueueItem) => resolveTaskTypeLabel(t, task.taskType);

    const cols: DataTableColumn<EscalationTaskQueueItem>[] = [
      {
        key: 'member',
        label: t('columns.member'),
        ...ESCALATION_TASK_COLUMN_LAYOUT.member,
        render: (task) => (
          <Link
            href={`/admin/members/${task.memberId}`}
            className="line-clamp-2 whitespace-normal break-words font-medium text-[var(--aura-fg-accent)] underline-offset-4 hover:underline"
            title={task.memberCompanyName ?? undefined}
          >
            {task.memberCompanyName ?? <span className="aura-text-mono text-xs">{task.memberId.slice(0, 8)}</span>}
          </Link>
        ),
      },
      {
        key: 'tier',
        label: t('columns.tier'),
        ...ESCALATION_TASK_COLUMN_LAYOUT.tier,
        render: (task) => (isTierBucket(task.memberTierBucket) ? <TierBadge tier={task.memberTierBucket} /> : dash),
      },
      {
        key: 'expiresAt',
        label: t('columns.expiresAt'),
        ...ESCALATION_TASK_COLUMN_LAYOUT.expiresAt,
        render: (task) => {
          const label = task.cycleExpiresAt === null ? null : formatShortDate(task.cycleExpiresAt);
          return label && task.cycleExpiresAt ? <time dateTime={task.cycleExpiresAt}>{label}</time> : dash;
        },
      },
      {
        key: 'taskType',
        label: t('columns.taskType'),
        ...ESCALATION_TASK_COLUMN_LAYOUT.taskType,
        render: (task) => (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal">
            {isTierBucket(task.memberTierBucket) ? (
              <span className="sm:hidden">
                <TierBadge tier={task.memberTierBucket} />
              </span>
            ) : null}
            {/* A long task type (a termination status runs to 59 characters)
                wraps in full: clipping it would hide the legal qualifier. */}
            <YearInCyclePill
              yearInCycle={task.yearInCycle}
              totalYears={task.totalYears}
              taskTypeLabel={taskTypeLabel(task)}
              labelClassName="break-words min-w-0 max-w-[22ch]"
            />
          </span>
        ),
      },
      {
        key: 'dueAt',
        label: t('columns.dueAt'),
        ...ESCALATION_TASK_COLUMN_LAYOUT.dueAt,
        render: (task) => (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal">
            <time dateTime={task.dueAt}>{formatShortDate(task.dueAt) ?? '—'}</time>
            {isOverdue(task) ? (
              <Badge tone="danger">
                {t('overdue_badge')}
              </Badge>
            ) : null}
            {/* The phone card adds the assignee after the date
                ("· Malin Berg (Admin)"); the table has its own column. A
                no-break space keeps the "·" with the name, while a long
                role still wraps. */}
            <span className="text-[var(--aura-fg-secondary)] sm:hidden">
              {'·\u00a0'}
              {assignee(task)} ({role(task)})
            </span>
          </span>
        ),
      },
      {
        key: 'assignedTo',
        label: t('columns.assignedTo'),
        ...ESCALATION_TASK_COLUMN_LAYOUT.assignedTo,
        render: (task) => (
          <span className="flex flex-col whitespace-normal" title={task.assignedToEmail ?? undefined}>
            <span>{assignee(task)}</span>
            <span className="text-xs text-[var(--aura-fg-secondary)]">{role(task)}</span>
          </span>
        ),
      },
      {
        key: 'status',
        label: t('columns.status'),
        ...ESCALATION_TASK_COLUMN_LAYOUT.status,
        render: (task) => <StatusPill tone={STATUS_TONE[task.status]}>{t(`status.${task.status}`)}</StatusPill>,
      },
    ];

    cols.push({
      // An empty label: AURA names the header "Actions" for screen readers.
      key: 'actions',
      label: '',
      ...ESCALATION_TASK_COLUMN_LAYOUT.actions,
      render: (task) => {
        const company = task.memberCompanyName ?? task.memberId;
        const timelineHref = `/admin/members/${task.memberId}/timeline`;
        if (!canMutate || task.status !== 'open') {
          // Nothing left to act on (a closed task, or a reader): the timeline
          // is the one thing the row offers.
          return (
            <Link
              href={timelineHref}
              aria-label={t('actions.view_timeline_for', { type: taskTypeLabel(task), company })}
              className={buttonClass({ variant: 'ghost', size: 'sm', touchHeight: true })}
            >
              {t('view_timeline')}
            </Link>
          );
        }
        const busy = pendingTaskId === task.taskId;
        const menuLabel = t('actions.row_menu_for', { type: taskTypeLabel(task), company });
        const menuItems: MenuItem[] = [
          {
            label: t('actions.skip.label'),
            disabled: busy,
            onSelect: () => openDialog('skip', task.taskId, menuTriggers.current.get(task.taskId) ?? null),
          },
          {
            label: t('actions.reassign.label'),
            disabled: busy,
            onSelect: () => openDialog('reassign', task.taskId, menuTriggers.current.get(task.taskId) ?? null),
          },
          { label: t('view_timeline'), href: timelineHref },
        ];
        return (
          <>
            <Button
              variant="secondary"
              size="sm"
              touchHeight
              disabled={busy}
              loading={busy && dialog?.action === 'done'}
              onClick={(e) => openDialog('done', task.taskId, e.currentTarget)}
              className="me-[var(--aura-space-1)]"
            >
              {t('actions.done.label')}
            </Button>
            <DropdownMenu
              label={menuLabel}
              items={menuItems}
              trigger={
                <IconButton
                  ref={(el) => {
                    if (el) menuTriggers.current.set(task.taskId, el);
                    else menuTriggers.current.delete(task.taskId);
                  }}
                  icon="ellipsis"
                  label={menuLabel}
                  size="sm"
                  touchHeight
                  aria-busy={busy || undefined}
                />
              }
            />
          </>
        );
      },
    });
    return cols;
  }, [t, now, canMutate, pendingTaskId, dialog, openDialog, formatShortDate]);

  const isFilterActive =
    assignment !== 'all' || assignmentPressed === null || taskTypeFilter !== '' || overdueOnly || status !== 'open';
  const dialogTask = dialog ? (items.find((task) => task.taskId === dialog.taskId) ?? null) : null;
  // A pressed toggle stays mounted even once the count drops to 0 (the
  // last overdue task just resolved): unmounting it dropped focus to <body>
  // and left browser Back as the only way to clear the filter (#487).
  const showOverdue = status === 'open' && (overdueOnly || overdueCount > 0);

  return (
    <div className="flex flex-col gap-[var(--aura-space-4)]">
      {!canMutate ? (
        <Alert tone="info" role="note">
          {t('manager_read_only_notice')}
        </Alert>
      ) : null}

      {/* R6 UX-I-1 — the live region stays mounted, so a count change is
          announced once and the toggle mounting is not. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {overdueCount > 0 && status === 'open' ? t('overdue_banner', { count: overdueCount }) : ''}
      </span>
      {showOverdue ? (
        // A toggle for `?overdue_only=`: its name stays the same in both
        // states (the state rides `aria-pressed`), and the copy is
        // device-neutral, since staff tap it on touch devices. Pressed, the
        // warning icon becomes a check and the fill deepens, so the state
        // does not rest on the ring alone.
        <button
          type="button"
          aria-pressed={overdueOnly}
          onClick={() => setSearchParam('overdue_only', overdueOnly ? null : 'true')}
          className="flex min-h-14 w-full items-center gap-3 rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-danger)] bg-[var(--aura-alert-danger-bg,var(--aura-bg-surface))] px-4 py-3 text-start text-[var(--aura-fg-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)] aria-pressed:bg-[color-mix(in_srgb,var(--aura-fg-danger)_15%,var(--aura-bg-surface))] aria-pressed:ring-2 aria-pressed:ring-[var(--aura-border-danger)]"
        >
          {overdueOnly ? (
            <Check className="size-5 shrink-0 text-[var(--aura-fg-danger)]" aria-hidden />
          ) : (
            <TriangleAlert className="size-5 shrink-0 text-[var(--aura-fg-danger)]" aria-hidden />
          )}
          <span className="flex flex-col">
            <span className="text-sm font-semibold">{t('overdue_banner', { count: overdueCount })}</span>
            <span className="text-xs text-[var(--aura-fg-secondary)]">{t('overdue_banner_cta')}</span>
          </span>
        </button>
      ) : null}

      <div role="group" aria-label={t('filters_aria')} className="flex flex-wrap items-end gap-[var(--aura-space-4)]">
        <PressedGroup
          label={t('status_filter_aria')}
          options={STATUS_FILTERS.map((s) => ({ value: s, label: t(`status_tab.${s}`) }))}
          value={status}
          onPress={(s) => setSearchParam('status', s)}
        />
        <PressedGroup
          label={t('assignment_filter_aria')}
          options={ASSIGNMENT_FILTERS.map((a) => ({ value: a, label: t(`assignment_tab.${a}`) }))}
          value={assignmentPressed}
          onPress={(a) => setSearchParam('assignment', a === 'all' ? null : a)}
        />
        {distinctTaskTypes.length > 1 ? (
          <div className="w-full sm:ms-auto sm:w-56">
            <Select
              label={t('task_type_filter_label')}
              value={taskTypeFilter === '' ? ALL_TASK_TYPES : taskTypeFilter}
              options={[
                { value: ALL_TASK_TYPES, label: t('task_type_filter_all') },
                ...distinctTaskTypes.map((tt) => ({ value: tt, label: resolveTaskTypeLabel(t, tt) })),
              ]}
              onChange={(e) =>
                setSearchParam('task_type', e.target.value === ALL_TASK_TYPES ? null : e.target.value || null)
              }
            />
          </div>
        ) : null}
      </div>

      {filteredItems.length === 0 ? (
        // E3 — distinct copy for "no tasks at all" and "the filter matched none".
        <EmptyState
          icon={CircleCheck}
          title={t(isFilterActive ? 'filter_active_state.title' : 'empty_state.title')}
          description={t(isFilterActive ? 'filter_active_state.subtitle' : 'empty_state.subtitle')}
          {...(isFilterActive
            ? {}
            : {
                action: (
                  <Button variant="secondary" onClick={() => setSearchParam('status', 'done')}>
                    {t('empty_state.cta_history')}
                  </Button>
                ),
              })}
        />
      ) : (
        <DataTable<EscalationTaskQueueItem>
          label={t('table_caption')}
          rows={filteredItems}
          columns={columns}
          rowKey="taskId"
          rowHeight="auto"
          stackBelow={640}
          // Edge to edge inside the list card from 640px up (AURA 5.27, #130);
          // "Next 50" can follow, so it does not end the card.
          bleed
        />
      )}

      <DoneTaskDialog
        open={dialog?.action === 'done'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        finalFocus={finalFocus}
        onSubmit={async (note) => {
          if (dialog === null) return;
          await postAction(dialog.taskId, 'done', { outcome_note: note });
        }}
      />
      <SkipTaskDialog
        open={dialog?.action === 'skip'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        finalFocus={finalFocus}
        onSubmit={async (reason) => {
          if (dialog === null) return;
          await postAction(dialog.taskId, 'skip', { skipped_reason: reason });
        }}
      />
      <ReassignTaskDropdown
        open={dialog?.action === 'reassign'}
        onOpenChange={(next) => {
          if (!next) setDialog(null);
        }}
        finalFocus={finalFocus}
        currentAssigneeUserId={dialogTask?.assignedToUserId ?? null}
        onSubmit={async (toUserId) => {
          if (dialog === null) return;
          await postAction(dialog.taskId, 'reassign', { to_user_id: toUserId });
        }}
      />
    </div>
  );
}
