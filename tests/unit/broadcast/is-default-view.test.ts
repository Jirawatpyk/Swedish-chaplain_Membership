/**
 * Task 3 review fix (Important, 2026-08-01-broadcast-review-queue-pr1)
 * — `isDefaultBroadcastView` must agree with `queue-filters.tsx`'s
 * `hasAnyFilter` on what counts as "a filter is active". Prior to this
 * fix, `page.tsx`'s inline `isDefaultView` expression omitted
 * `fromDate`/`toDate`, so a date-filtered URL would still show the
 * overdue banner + truncation note as if the view were the pristine
 * default — the exact "banner over a filtered subset" bug the design
 * warns against. Inert today (date params aren't wired into the query
 * yet) but becomes live the moment date filtering ships.
 */
import { describe, expect, it } from 'vitest';
import { isDefaultBroadcastView } from '@/app/(staff)/admin/broadcasts/_lib/is-default-view';

describe('isDefaultBroadcastView', () => {
  it('is true for a pristine view with no params', () => {
    expect(isDefaultBroadcastView({})).toBe(true);
  });
  it('is false when status_all sentinel is set', () => {
    expect(isDefaultBroadcastView({ status_all: '1' })).toBe(false);
  });
  it('is false when a status filter is set', () => {
    expect(isDefaultBroadcastView({ status: 'submitted' })).toBe(false);
  });
  it('is false when a member filter is set', () => {
    expect(isDefaultBroadcastView({ memberId: 'm1' })).toBe(false);
  });
  it('is false when a fromDate filter is set', () => {
    expect(isDefaultBroadcastView({ fromDate: '2026-06-01' })).toBe(false);
  });
  it('is false when a toDate filter is set', () => {
    expect(isDefaultBroadcastView({ toDate: '2026-06-30' })).toBe(false);
  });
});
