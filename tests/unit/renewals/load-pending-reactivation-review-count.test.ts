/**
 * #765 — the pending-review list still loads its first 200 rows, but the
 * Renewals tab badge and the "showing the first N of M" notice need the
 * TRUE count, not the length of the capped list. The use case reads it
 * from `cyclesRepo.countPendingReview` (same predicate as the list:
 * `pending_admin_reactivation`, erased members excluded; `open` = no
 * reject-refund started) and passes it through.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadPendingReactivationReview } from '@/modules/renewals';

describe('loadPendingReactivationReview — true counts (#765)', () => {
  it('returns the first page plus the total and open counts from the repo', async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ cycleId: 'c1' }], nextCursor: null });
    const countPendingReview = vi.fn().mockResolvedValue({ total: 230, open: 214 });
    const res = await loadPendingReactivationReview(
      { cyclesRepo: { list, countPendingReview } } as never,
      { tenantId: 't1' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.cycles).toHaveLength(1);
    expect(res.value.totalCount).toBe(230);
    expect(res.value.openCount).toBe(214);
    expect(countPendingReview).toHaveBeenCalledWith('t1');
    // The list read is unchanged: same filter, same first-200 cap.
    expect(list).toHaveBeenCalledWith('t1', expect.objectContaining({
      statusFilter: ['pending_admin_reactivation'],
      pageSize: 200,
      excludeErasedMembers: true,
    }));
  });
});
