/**
 * F119 round-4 B7 — `isUpcomingPreset`: the send-time order is the Upcoming
 * sends preset's, and ONLY with its `from=now` bound.
 *
 * The list pages by keyset on (`scheduled_for`, id). Unbounded, the view holds
 * rows with no send time; their cursor key is NULL, `(NULL, id) > (…)` is
 * never true, and every unscheduled row after page 1 vanished. With
 * `from=now`, `scheduled_for >= now` excludes NULLs, so the keyset is whole.
 * The page falls back to the view's own order; the list API refuses (400).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ runInTenant: vi.fn() }));

import { isUpcomingPreset, queueSortFor } from '@/lib/admin-broadcast-queue';

describe('isUpcomingPreset', () => {
  it('sort=scheduled_for with from=now → the preset', () => {
    expect(isUpcomingPreset('scheduled_for', 'now')).toBe(true);
  });

  it.each([
    ['scheduled_for', undefined],
    ['scheduled_for', 'yesterday'],
    [undefined, 'now'],
    ['submitted_at_asc', 'now'],
  ])('sort=%s from=%s → not the preset', (sort, from) => {
    expect(isUpcomingPreset(sort, from)).toBe(false);
  });

  it('what the page orders by: the send time only for the preset, else the view order', () => {
    expect(queueSortFor(['approved'], isUpcomingPreset('scheduled_for', 'now'))).toBe('scheduled_for_asc');
    expect(queueSortFor(['approved'], isUpcomingPreset('scheduled_for', undefined))).toBe('stage_entered_at_desc');
  });
});
