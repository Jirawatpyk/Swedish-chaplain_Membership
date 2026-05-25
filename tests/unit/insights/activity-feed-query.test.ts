/**
 * `activityFeedQuery` unit test — role-aware finance redaction (C-3 / FR-007).
 *
 * Managers get a finance-redacted dashboard, so finance-bearing audit events
 * (payment/refund/invoice/credit-note summaries can embed satang amounts) must
 * not reach the manager activity feed. Admins see the full feed.
 */
import { describe, expect, it, vi } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import {
  activityFeedQuery,
  type ActivityFeedMeta,
} from '@/modules/insights/application/use-cases/activity-feed-query';
import type {
  ActivityFeedItem,
  ActivityFeedSource,
} from '@/modules/insights/application/ports/activity-feed-source';

const ctx = asTenantContext('test-tenant');

const meta = (role: ActivityFeedMeta['actorRole']): ActivityFeedMeta => ({
  actorUserId: 'u-1',
  actorRole: role,
  requestId: 'req-1',
});

function item(id: string, eventType: string): ActivityFeedItem {
  return {
    id,
    eventType,
    actorUserId: 'actor-1',
    summary: `${eventType} summary`,
    occurredAt: '2026-06-15T05:00:00.000Z',
  };
}

// Mix of finance + non-finance events, newest-first.
const MIXED: readonly ActivityFeedItem[] = [
  item('1', 'member_created'),
  item('2', 'payment_succeeded'),
  item('3', 'invoice_issued'),
  item('4', 'member_updated'),
  item('5', 'refund_succeeded'),
  item('6', 'broadcast_approved'),
];

function depsReturning(items: readonly ActivityFeedItem[]): {
  deps: { activitySource: ActivityFeedSource };
  recent: ReturnType<typeof vi.fn>;
} {
  const recent = vi.fn().mockResolvedValue(items);
  return { deps: { activitySource: { recent } }, recent };
}

describe('activityFeedQuery', () => {
  it('forbids members', async () => {
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery({ limit: 10 }, meta('member'), ctx, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(recent).not.toHaveBeenCalled();
  });

  it('admin sees the full feed (no redaction)', async () => {
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery({ limit: 10 }, meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    // Admin fetches exactly `limit`.
    expect(recent).toHaveBeenCalledWith(ctx, 10);
  });

  it('manager feed excludes finance-bearing events (FR-007 / SC-011)', async () => {
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery({ limit: 10 }, meta('manager'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ids = result.value.map((e) => e.id);
      // payment_succeeded (2), invoice_issued (3), refund_succeeded (5) dropped.
      expect(ids).toEqual(['1', '4', '6']);
      expect(result.value.some((e) => e.eventType.startsWith('payment_'))).toBe(false);
      expect(result.value.some((e) => e.eventType.startsWith('invoice_'))).toBe(false);
      expect(result.value.some((e) => e.eventType.startsWith('refund_'))).toBe(false);
    }
    // Manager over-fetches (limit*3, capped at 100) to stay near `limit` after filtering.
    expect(recent).toHaveBeenCalledWith(ctx, 30);
  });

  it('manager result is capped to `limit` after redaction', async () => {
    // 8 non-finance events; limit 3 → exactly 3 returned.
    const many = Array.from({ length: 8 }, (_, i) => item(`m${i}`, 'member_updated'));
    const { deps } = depsReturning(many);
    const result = await activityFeedQuery({ limit: 3 }, meta('manager'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toHaveLength(3);
  });

  it('manager over-fetch is capped at 100 (limit*3 would exceed)', async () => {
    const { deps, recent } = depsReturning([]);
    await activityFeedQuery({ limit: 40 }, meta('manager'), ctx, deps);
    // 40*3 = 120 → clamped to 100.
    expect(recent).toHaveBeenCalledWith(ctx, 100);
  });

  it('manager feed redacts refund-anomaly events (substring, not just refund_*)', async () => {
    const events = [
      item('a', 'member_created'),
      item('b', 'out_of_band_refund_detected'),
      item('c', 'stale_pending_refund_detected'),
      item('d', 'member_updated'),
    ];
    const { deps } = depsReturning(events);
    const result = await activityFeedQuery({ limit: 10 }, meta('manager'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((e) => e.id)).toEqual(['a', 'd']);
      expect(result.value.some((e) => e.eventType.includes('refund'))).toBe(false);
    }
  });
});
