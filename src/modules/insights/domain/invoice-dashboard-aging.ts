/**
 * 124 invoice dashboard — "Unpaid invoices by age" (spec US1.3, US2.2).
 * Pure, no framework imports.
 *
 * An issued invoice's bucket is how many calendar days its `due_date` lies
 * before Bangkok `today`: due today or later is "not yet due" (an invoice due
 * today is not overdue, matching `computeIsOverdue`), then 1–30, 31–60, 61–90
 * and over 90 days past due.
 *
 * Each bucket IS a due-date range in the invoice list's own semantics —
 * `dueAfter` inclusive (`due_date >= dueAfter`), `dueBefore` exclusive
 * (`due_date < dueBefore`) — so the bucket a row lands in, the SQL that sums
 * it and the drill-down link it opens all come from {@link agingBucketDueRange}
 * with the same `today`. `today` is a parameter, computed once per request;
 * nothing here reads a clock.
 */
import { addDays } from '@/lib/fiscal-year';

export const AGING_BUCKETS = [
  'not_yet_due',
  'days_1_30',
  'days_31_60',
  'days_61_90',
  'over_90',
] as const;

export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** Half-open due-date range: `dueAfter <= due_date < dueBefore`; a missing side is open. */
export interface DueDateRange {
  readonly dueAfter?: string;
  readonly dueBefore?: string;
}

/** The due-date range of `bucket` relative to Bangkok `today` (`YYYY-MM-DD`). */
export function agingBucketDueRange(bucket: AgingBucket, today: string): DueDateRange {
  switch (bucket) {
    case 'not_yet_due':
      return { dueAfter: today };
    case 'days_1_30':
      return { dueAfter: addDays(today, -30), dueBefore: today };
    case 'days_31_60':
      return { dueAfter: addDays(today, -60), dueBefore: addDays(today, -30) };
    case 'days_61_90':
      return { dueAfter: addDays(today, -90), dueBefore: addDays(today, -60) };
    case 'over_90':
      return { dueBefore: addDays(today, -90) };
  }
}

/** The bucket of a `YYYY-MM-DD` due date relative to Bangkok `today`. */
export function agingBucketOf(dueDate: string, today: string): AgingBucket {
  // YYYY-MM-DD strings compare lexicographically == chronologically.
  if (dueDate >= today) return 'not_yet_due';
  if (dueDate >= addDays(today, -30)) return 'days_1_30';
  if (dueDate >= addDays(today, -60)) return 'days_31_60';
  if (dueDate >= addDays(today, -90)) return 'days_61_90';
  return 'over_90';
}
