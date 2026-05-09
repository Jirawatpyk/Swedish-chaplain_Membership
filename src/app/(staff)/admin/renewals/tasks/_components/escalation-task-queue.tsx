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
 *
 * Action dialogs live in sibling files:
 *   - DoneTaskDialog (T221)
 *   - SkipTaskDialog (T221)
 *   - ReassignTaskDropdown (T222)
 */
'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { DoneTaskDialog } from './done-task-dialog';
import { SkipTaskDialog } from './skip-task-dialog';
import { ReassignTaskDropdown } from './reassign-task-dropdown';
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
  readonly dueAt: string;
  readonly status: 'open' | 'done' | 'skipped';
  readonly createdAt: string;
  /**
   * Optional multi-year cycle context for the year-in-cycle pill (T220).
   * `yearInCycle: 1` + `totalYears: 1` collapses the pill to just the
   * task-type label (single-year contracts get no "Year 1 of 1" prefix).
   * Both fields default to 1/1 when the cycle metadata isn't surfaced.
   */
  readonly yearInCycle?: number;
  readonly totalYears?: number;
}

export interface EscalationTaskQueueProps {
  readonly actorRole: 'admin' | 'manager' | 'member';
  readonly actorUserId: string;
  readonly overdueCount: number;
  readonly items: ReadonlyArray<EscalationTaskQueueItem>;
}

type AssignmentFilter = 'all' | 'mine' | 'unassigned';

const OVERDUE_HIGHLIGHT_DAYS = 3;
const OVERDUE_HIGHLIGHT_MS = OVERDUE_HIGHLIGHT_DAYS * 24 * 60 * 60 * 1000;

export function EscalationTaskQueue({
  actorRole,
  actorUserId,
  overdueCount,
  items,
}: EscalationTaskQueueProps) {
  const t = useTranslations('admin.renewals.tasks');
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [doneDialogTaskId, setDoneDialogTaskId] = useState<string | null>(null);
  const [skipDialogTaskId, setSkipDialogTaskId] = useState<string | null>(null);
  const [reassignDialogTaskId, setReassignDialogTaskId] = useState<
    string | null
  >(null);

  // Filters live in URL search params so the back button + sharing
  // works. Defaults: status='open', assignment='all'.
  const status = searchParams.get('status') ?? 'open';
  const assignment = (searchParams.get('assignment') ??
    'all') as AssignmentFilter;
  const taskTypeFilter = searchParams.get('task_type') ?? '';
  const overdueOnly =
    searchParams.get('overdue_only') === 'true' ||
    searchParams.get('overdue_only') === '1';

  const now = Date.now();

  const filteredItems = useMemo(() => {
    return items.filter((task) => {
      if (assignment === 'mine' && task.assignedToUserId !== actorUserId) {
        return false;
      }
      if (assignment === 'unassigned' && task.assignedToUserId !== null) {
        return false;
      }
      if (taskTypeFilter !== '' && task.taskType !== taskTypeFilter) {
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
  }, [items, assignment, taskTypeFilter, overdueOnly, actorUserId, now]);

  const distinctTaskTypes = useMemo(() => {
    const set = new Set<string>();
    items.forEach((t) => set.add(t.taskType));
    return Array.from(set).sort();
  }, [items]);

  function setSearchParam(name: string, value: string | null): void {
    const params = new URLSearchParams(searchParams.toString());
    if (value === null || value === '') {
      params.delete(name);
    } else {
      params.set(name, value);
    }
    const qs = params.toString();
    startTransition(() => router.replace(qs.length > 0 ? `?${qs}` : '?'));
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
        toast.error(t(`actions.${action}.error`), {
          description: errBody?.error?.code ?? '',
        });
        return false;
      }
      toast.success(t(`actions.${action}.success`));
      startTransition(() => router.refresh());
      return true;
    } catch (e) {
      toast.error(t(`actions.${action}.error`), {
        description: e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      setPendingTaskId(null);
    }
  }

  const reassigningTask =
    reassignDialogTaskId !== null
      ? items.find((t) => t.taskId === reassignDialogTaskId) ?? null
      : null;
  const canMutate = actorRole === 'admin';

  return (
    <>
      {/* Overdue banner — only shows when overdueCount > 0 and we're
          on the Open tab. E2 close: clickable button that filters the
          queue to overdue-only tasks (toggles off when already filter
          is active). aria-live keeps the announcement for screen
          readers when the count first appears. */}
      {overdueCount > 0 && status === 'open' && (
        <button
          type="button"
          className="mb-4 flex w-full items-start gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-left transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50"
          aria-live="polite"
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
      )}

      {/* Filter chips */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="tablist" aria-label={t('status_tabs_aria')}>
          {(['open', 'done', 'skipped'] as const).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={status === s ? 'default' : 'outline'}
              role="tab"
              aria-selected={status === s}
              onClick={() => setSearchParam('status', s)}
            >
              {t(`status_tab.${s}`)}
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['all', 'mine', 'unassigned'] as const).map((a) => (
            <Button
              key={a}
              size="sm"
              variant={assignment === a ? 'secondary' : 'ghost'}
              onClick={() =>
                setSearchParam('assignment', a === 'all' ? null : a)
              }
            >
              {t(`assignment_tab.${a}`)}
            </Button>
          ))}
        </div>
        {distinctTaskTypes.length > 1 && (
          <select
            className="ml-auto rounded-md border bg-background px-2 py-1 text-sm"
            value={taskTypeFilter}
            onChange={(e) =>
              setSearchParam('task_type', e.target.value === '' ? null : e.target.value)
            }
            aria-label={t('task_type_filter_aria')}
          >
            <option value="">{t('task_type_filter_all')}</option>
            {distinctTaskTypes.map((tt) => (
              <option key={tt} value={tt}>
                {t(`taskType.${tt}`)}
              </option>
            ))}
          </select>
        )}
      </div>

      {filteredItems.length === 0 ? (
        // E3 close — distinct copy for "no tasks at all" vs "filter
        // returned no rows". Spec FR-046a calls for "No pending tasks"
        // + history link on the truly-empty state; the filter-active
        // state gets a more actionable copy that hints which filter
        // to clear.
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
            <div className="py-12 text-center" role="status">
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
        <div className="rounded-md border">
          <Table>
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
                    <TableCell>
                      <Link
                        href={`/admin/members/${task.memberId}`}
                        className="font-medium text-primary underline-offset-4 hover:underline"
                      >
                        {task.memberCompanyName ?? (
                          <span className="font-mono text-xs">
                            {task.memberId.slice(0, 8)}
                          </span>
                        )}
                      </Link>
                      {/* Member-id always available to assistive tech for
                          unambiguous identification when names collide. */}
                      <span className="sr-only"> · {task.memberId}</span>
                    </TableCell>
                    <TableCell>
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
                    <TableCell>
                      {task.cycleExpiresAt !== null ? (
                        <time
                          dateTime={task.cycleExpiresAt}
                          className="text-sm"
                        >
                          {new Date(task.cycleExpiresAt)
                            .toISOString()
                            .slice(0, 10)}
                        </time>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <YearInCyclePill
                        yearInCycle={task.yearInCycle ?? 1}
                        totalYears={task.totalYears ?? 1}
                        taskTypeLabel={t(`taskType.${task.taskType}`)}
                      />
                    </TableCell>
                    <TableCell>
                      <time dateTime={task.dueAt}>
                        {new Date(task.dueAt).toISOString().slice(0, 10)}
                      </time>
                      {isOverdue && (
                        <span className="ml-2 rounded-full bg-destructive/20 px-1.5 py-0.5 text-xs font-medium text-destructive">
                          {t('overdue_badge')}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {task.assignedToUserId !== null ? (
                        <span className="font-mono">
                          {task.assignedToUserId.slice(0, 8)}
                        </span>
                      ) : (
                        <span className="rounded-full bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
                          {t(`assigneeRole.${task.assignedToRole}`)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium">
                        {t(`status.${task.status}`)}
                      </span>
                    </TableCell>
                    {canMutate && (
                      <TableCell className="text-right">
                        <div className="inline-flex gap-2">
                          <Button
                            size="sm"
                            variant="default"
                            disabled={!isOpen || busy}
                            aria-busy={busy}
                            onClick={() => setDoneDialogTaskId(task.taskId)}
                          >
                            {t('actions.done.label')}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!isOpen || busy}
                            aria-busy={busy}
                            onClick={() => setSkipDialogTaskId(task.taskId)}
                          >
                            {t('actions.skip.label')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!isOpen || busy}
                            aria-busy={busy}
                            onClick={() => setReassignDialogTaskId(task.taskId)}
                          >
                            {t('actions.reassign.label')}
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Action dialogs. Only one open at a time. */}
      <DoneTaskDialog
        open={doneDialogTaskId !== null}
        onOpenChange={(next) => {
          if (!next) setDoneDialogTaskId(null);
        }}
        onSubmit={async (note) => {
          if (doneDialogTaskId === null) return;
          const ok = await postAction(doneDialogTaskId, 'done', {
            outcome_note: note,
          });
          if (ok) setDoneDialogTaskId(null);
        }}
      />

      <SkipTaskDialog
        open={skipDialogTaskId !== null}
        onOpenChange={(next) => {
          if (!next) setSkipDialogTaskId(null);
        }}
        onSubmit={async (reason) => {
          if (skipDialogTaskId === null) return;
          const ok = await postAction(skipDialogTaskId, 'skip', {
            skipped_reason: reason,
          });
          if (ok) setSkipDialogTaskId(null);
        }}
      />

      <ReassignTaskDropdown
        open={reassignDialogTaskId !== null}
        onOpenChange={(next) => {
          if (!next) setReassignDialogTaskId(null);
        }}
        currentAssigneeUserId={reassigningTask?.assignedToUserId ?? null}
        onSubmit={async (toUserId) => {
          if (reassignDialogTaskId === null) return;
          const ok = await postAction(reassignDialogTaskId, 'reassign', {
            to_user_id: toUserId,
          });
          if (ok) setReassignDialogTaskId(null);
        }}
      />
    </>
  );
}
