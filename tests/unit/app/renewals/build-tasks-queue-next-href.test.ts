/**
 * UX-audit PR-A #1 — `/admin/renewals/tasks` "Next 50" keyset link builder.
 *
 * Proves the footer link renders only when a next page exists and that it
 * preserves the active filter state alongside the cursor (so keyset page 2
 * decodes under the same filters it was minted under). Pure — no render.
 */
import { describe, it, expect } from 'vitest';
import { buildTasksQueueNextHref } from '@/app/(staff)/admin/renewals/tasks/_lib/build-tasks-queue-next-href';

describe('buildTasksQueueNextHref', () => {
  it('returns null when there is no next page (nextCursor === null)', () => {
    expect(
      buildTasksQueueNextHref({
        status: 'open',
        assignment: undefined,
        taskType: '',
        overdueOnly: false,
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it('sets the cursor and omits all default filters on the first page', () => {
    const href = buildTasksQueueNextHref({
      status: 'open',
      assignment: undefined,
      taskType: '',
      overdueOnly: false,
      nextCursor: '2026-04-10T00:00:00.000Z|task-9',
    });
    expect(href).toBe(
      '/admin/renewals/tasks?cursor=2026-04-10T00%3A00%3A00.000Z%7Ctask-9',
    );
  });

  it('preserves the active status / assignment / task_type / overdue filters with the cursor', () => {
    const href = buildTasksQueueNextHref({
      status: 'done',
      assignment: 'unassigned',
      taskType: 'director_call',
      overdueOnly: true,
      nextCursor: 'C1',
    });
    const url = new URL(href ?? '', 'https://x.test');
    expect(url.pathname).toBe('/admin/renewals/tasks');
    expect(url.searchParams.get('status')).toBe('done');
    expect(url.searchParams.get('assignment')).toBe('unassigned');
    expect(url.searchParams.get('task_type')).toBe('director_call');
    expect(url.searchParams.get('overdue_only')).toBe('true');
    expect(url.searchParams.get('cursor')).toBe('C1');
  });

  it("treats assignment='all' as the default and omits it", () => {
    const href = buildTasksQueueNextHref({
      status: 'open',
      assignment: 'all',
      taskType: '',
      overdueOnly: false,
      nextCursor: 'C2',
    });
    expect(href).not.toContain('assignment');
    expect(href).toContain('cursor=C2');
  });
});
