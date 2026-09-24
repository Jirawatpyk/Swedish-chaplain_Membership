/**
 * F119 dashboard UX review H1 / H3 / H4 — the page's view helpers
 * (`src/app/(staff)/admin/broadcasts/_lib/queue-view.ts`).
 *
 *   - H3: the announced total is the VIEW's — the per-stage chip counts summed
 *     over the stages the view holds — and it is `null` whenever those counts
 *     cannot answer (a member filter, the Upcoming preset's time bound, a failed
 *     count read), unless the page itself is provably the whole view.
 *   - H4: the view key is the URL query, stable under parameter order.
 *   - H1: the pagination links keep the view and move only the cursor.
 */
import { describe, expect, it } from 'vitest';
import {
  queueOrderOf,
  queuePageHref,
  queueViewKey,
  queueViewTotal,
} from '@/app/(staff)/admin/broadcasts/_lib/queue-view';
import {
  BROADCAST_STATUSES,
  type BroadcastStatus,
} from '@/modules/broadcasts/domain/value-objects/broadcast-status';

const counts = (overrides: Partial<Record<BroadcastStatus, number>>) =>
  Object.fromEntries(BROADCAST_STATUSES.map((s) => [s, overrides[s] ?? 0])) as Record<BroadcastStatus, number>;

const base = {
  stageCounts: counts({ submitted: 70, sent: 60, draft: 3 }),
  allStatuses: BROADCAST_STATUSES,
  narrowed: false,
  firstPage: true,
  rowsOnPage: 50,
  hasNextPage: true,
};

describe('queueViewTotal (UX review H3)', () => {
  it('sums the chip counts over the selected stages, each stage once', () => {
    expect(queueViewTotal({ ...base, statusFilter: ['submitted', 'sent', 'sent'] })).toBe(130);
  });

  it('the show-all view sums every stage', () => {
    expect(queueViewTotal({ ...base, statusFilter: [] })).toBe(133);
  });

  it('a member filter or the Upcoming bound makes the chip counts the wrong answer → null', () => {
    expect(queueViewTotal({ ...base, statusFilter: ['submitted'], narrowed: true })).toBeNull();
  });

  it('a failed count read → null', () => {
    expect(queueViewTotal({ ...base, stageCounts: null, statusFilter: ['submitted'] })).toBeNull();
  });

  it('…unless the first page has no next page — then the page IS the view', () => {
    expect(
      queueViewTotal({ ...base, stageCounts: null, statusFilter: ['submitted'], rowsOnPage: 7, hasNextPage: false }),
    ).toBe(7);
    expect(
      queueViewTotal({ ...base, narrowed: true, statusFilter: ['submitted'], rowsOnPage: 7, hasNextPage: false }),
    ).toBe(7);
    // A later page is not the whole view.
    expect(
      queueViewTotal({
        ...base,
        narrowed: true,
        statusFilter: ['submitted'],
        firstPage: false,
        rowsOnPage: 7,
        hasNextPage: false,
      }),
    ).toBeNull();
  });
});

describe('queueViewKey (UX review H4)', () => {
  it('is the query, independent of parameter order, repeated values kept', () => {
    expect(queueViewKey({ status: ['sent', 'submitted'], memberId: 'm1' })).toBe(
      queueViewKey({ memberId: 'm1', status: ['sent', 'submitted'] }),
    );
    expect(queueViewKey({ status: 'sent' })).not.toBe(queueViewKey({ status: 'submitted' }));
    expect(queueViewKey({})).toBe('');
  });
});

describe('queuePageHref (UX review H1)', () => {
  it('keeps every view parameter and sets the cursor', () => {
    const href = queuePageHref({ status: ['sent', 'rejected'], memberId: 'm1', cursor: 'old' }, 'next');
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/admin/broadcasts');
    expect(url.searchParams.getAll('status')).toEqual(['sent', 'rejected']);
    expect(url.searchParams.get('memberId')).toBe('m1');
    expect(url.searchParams.get('cursor')).toBe('next');
  });

  it('with no cursor it is the first page of the same view', () => {
    const url = new URL(queuePageHref({ status: 'sent', cursor: 'old' }, null), 'http://x');
    expect(url.searchParams.get('status')).toBe('sent');
    expect(url.searchParams.has('cursor')).toBe(false);
    expect(queuePageHref({ cursor: 'old' }, null)).toBe('/admin/broadcasts');
  });
});

describe('queueOrderOf (UX review H1 / M1)', () => {
  it('names the order each repo sort reads in', () => {
    expect(queueOrderOf('stage_entered_at_asc')).toBe('longest_in_stage');
    expect(queueOrderOf('stage_entered_at_desc')).toBe('most_recent');
    expect(queueOrderOf('scheduled_for_asc')).toBe('send_time');
  });
});
