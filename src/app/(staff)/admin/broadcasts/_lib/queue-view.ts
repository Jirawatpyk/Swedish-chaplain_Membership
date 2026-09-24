/**
 * F119 dashboard UX review H1 / H3 / H4 — pure helpers for the queue page's
 * VIEW: what the whole view holds, what identifies it, how to page it, and
 * which order it reads in. Framework-free (like `is-default-view.ts`) so they
 * are unit-testable apart from the page's server boundary.
 */
import type { BroadcastStatus, ListByTenantStatusSort } from '@/modules/broadcasts';
import type { QueueOrder } from '@/components/broadcast/admin/queue-table-client';
import type { TenantDayRange } from '@/lib/tenant-day-range';

/** The page's own URL parameters, exactly as Next hands them over. */
export type QueueSearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const QUEUE_PATH = '/admin/broadcasts';

export interface QueueViewNarrowingInput {
  readonly memberId?: string;
  /** The Upcoming sends preset's bound on `scheduled_for`. */
  readonly scheduledFrom?: Date;
  /** FR-030's date range on `submitted_at`, as the list query received it. */
  readonly submitted: TenantDayRange;
}

/**
 * FR-030 + UX review H3 — is a filter on that the per-stage chip counts cannot
 * see? The counts are per stage for the whole tenant, so a member filter, the
 * Upcoming bound or a date range each make their sum the wrong total for the
 * view.
 */
export function queueViewNarrowed(input: QueueViewNarrowingInput): boolean {
  return (
    input.memberId !== undefined ||
    input.scheduledFrom !== undefined ||
    input.submitted.fromInclusive !== undefined ||
    input.submitted.toExclusive !== undefined
  );
}

export interface QueueViewTotalInput {
  /** Rows per status for the tenant (the chip counts); `null` when that read failed. */
  readonly stageCounts: Readonly<Record<BroadcastStatus, number>> | null;
  /** The stages the list was asked for; empty = every stage (show-all). */
  readonly statusFilter: readonly BroadcastStatus[];
  readonly allStatuses: readonly BroadcastStatus[];
  /** A member filter, the Upcoming preset's time bound or the FR-030 date range is on — the chip counts see none of them. */
  readonly narrowed: boolean;
  readonly firstPage: boolean;
  readonly rowsOnPage: number;
  readonly hasNextPage: boolean;
}

/**
 * UX review H3 — how many E-Blasts the whole view holds, or `null` when that
 * is not known. The chip counts are per stage for the whole tenant, so their
 * sum over the view's stages IS the view — until a member filter, a time
 * bound or a date range narrows it, which they cannot see. A first page with no next page is
 * the whole view whatever narrowed it.
 */
export function queueViewTotal(input: QueueViewTotalInput): number | null {
  if (!input.narrowed && input.stageCounts !== null) {
    const counts = input.stageCounts;
    const stages = new Set(input.statusFilter.length > 0 ? input.statusFilter : input.allStatuses);
    let total = 0;
    for (const s of stages) total += counts[s];
    return total;
  }
  if (input.firstPage && !input.hasNextPage) return input.rowsOnPage;
  return null;
}

function entriesOf(params: QueueSearchParams): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === 'string') out.push([key, value]);
    else for (const v of value) out.push([key, v]);
  }
  return out;
}

/**
 * UX review H4 — the view's identity: its URL query, keys sorted (a repeated
 * `status` keeps its own order — it is one value list). A change of view is
 * announced even when it lands on the same rows.
 */
export function queueViewKey(params: QueueSearchParams): string {
  const sorted = entriesOf(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(sorted).toString();
}

/**
 * UX review H1 — the link to another page of the SAME view: every parameter
 * kept, the keyset `cursor` replaced (or dropped for the first page).
 */
export function queuePageHref(params: QueueSearchParams, cursor: string | null): string {
  const query = new URLSearchParams(entriesOf(params).filter(([key]) => key !== 'cursor'));
  if (cursor !== null) query.set('cursor', cursor);
  const text = query.toString();
  return text === '' ? QUEUE_PATH : `${QUEUE_PATH}?${text}`;
}

/** UX review H1 / M1 — the order a repo sort reads in, for `aria-sort` and the visible hint. */
export function queueOrderOf(sort: ListByTenantStatusSort): QueueOrder {
  switch (sort) {
    case 'scheduled_for_asc':
      return 'send_time';
    case 'stage_entered_at_asc':
    case 'submitted_at_asc':
      return 'longest_in_stage';
    case 'stage_entered_at_desc':
    case 'submitted_at_desc':
    case 'created_at_desc':
      return 'most_recent';
  }
}
