/**
 * UX-audit PR-A #1 — build the `/admin/renewals/tasks` "Next 50" keyset link.
 *
 * Mirrors the pipeline's pagination-URL discipline
 * (`src/app/(staff)/admin/renewals/page.tsx`): preserve the CURRENT filter
 * state (status / assignment / task_type / overdue_only) and set the opaque
 * keyset `cursor`. Returns `null` when there is no further page
 * (`nextCursor === null`) so the caller renders no footer.
 *
 * Only NON-DEFAULT filters are written to the URL — the page re-derives the
 * defaults (status='open', assignment absent, no type, not overdue-only) when a
 * param is missing, matching how the queue component's `setSearchParam` prunes
 * defaults. The cursor MUST ride with the exact same filters it was minted
 * under, or the keyset decode on page 2 would skip/duplicate rows.
 *
 * Pure (no React/Next imports) so the URL contract is unit-testable without
 * rendering the server component.
 */
export interface TasksQueueNextHrefInput {
  readonly status: 'open' | 'done' | 'skipped';
  /** Raw `?assignment=` value ('mine' | 'unassigned' | a colleague UUID | 'all' | undefined). */
  readonly assignment: string | undefined;
  /** Resolved task_type filter ('' when none). */
  readonly taskType: string;
  readonly overdueOnly: boolean;
  /** The repo's keyset cursor; `null` when the current page is the last. */
  readonly nextCursor: string | null;
}

/** The current filter state, without any cursor (the defaults omitted). */
function filterParams(input: Omit<TasksQueueNextHrefInput, 'nextCursor'>): URLSearchParams {
  const p = new URLSearchParams();
  // status defaults to 'open' when absent — omit it in that case.
  if (input.status !== 'open') p.set('status', input.status);
  // assignment defaults to 'all' (== absent) — preserve any active tray verbatim.
  if (input.assignment !== undefined && input.assignment !== 'all') {
    p.set('assignment', input.assignment);
  }
  if (input.taskType !== '') p.set('task_type', input.taskType);
  if (input.overdueOnly) p.set('overdue_only', 'true');
  return p;
}

export function buildTasksQueueNextHref(
  input: TasksQueueNextHrefInput,
): string | null {
  if (input.nextCursor === null) return null;
  const p = filterParams(input);
  p.set('cursor', input.nextCursor);
  return `/admin/renewals/tasks?${p.toString()}`;
}

/**
 * The footer's "First page" link (PR #757 review): the same filters with the
 * cursor dropped, so page 2+ of the forward-only keyset has a way back.
 * `null` on the first page (no `cursor` in the current URL).
 */
export function buildTasksQueueFirstHref(
  input: Omit<TasksQueueNextHrefInput, 'nextCursor'> & { readonly cursor: string | undefined },
): string | null {
  if (input.cursor === undefined) return null;
  const query = filterParams(input).toString();
  return query === '' ? '/admin/renewals/tasks' : `/admin/renewals/tasks?${query}`;
}
