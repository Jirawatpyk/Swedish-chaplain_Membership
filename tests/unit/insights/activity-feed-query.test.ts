/**
 * `activityFeedQuery` unit test — role access (FR-003 / FR-007).
 *
 * The feed is a staff-only dashboard widget. Members are forbidden; admins and
 * the "read-only on finance" manager role both see the FULL feed (FR-007 makes
 * finance visible to managers across the dashboard — the feed no longer drops
 * finance-bearing events).
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
  it('forbids members without reading the source', async () => {
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery({ limit: 10 }, meta('member'), ctx, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(recent).not.toHaveBeenCalled();
  });

  it('admin sees the full feed (incl. finance events), fetching exactly `limit`', async () => {
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery({ limit: 10 }, meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(recent).toHaveBeenCalledWith(ctx, 10);
  });

  it('manager sees the SAME full feed as admin incl. finance events (FR-007)', async () => {
    // The "read-only on finance" manager may VIEW finance figures, so the feed
    // no longer drops payment/invoice/refund events for managers.
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery({ limit: 10 }, meta('manager'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '6']);
      // Finance events are present for managers (no redaction).
      expect(result.value.some((e) => e.eventType.startsWith('payment_'))).toBe(true);
      expect(result.value.some((e) => e.eventType.includes('refund'))).toBe(true);
    }
    // No over-fetch any more — fetches exactly `limit`, same as admin.
    expect(recent).toHaveBeenCalledWith(ctx, 10);
  });

  it('manager: email in a summary is redacted; admin sees it verbatim (R001)', async () => {
    const withEmail: readonly ActivityFeedItem[] = [
      { ...item('1', 'account_disabled'), summary: 'disabled manager user@example.com' },
    ];
    const mgr = await activityFeedQuery({ limit: 5 }, meta('manager'), ctx, depsReturning(withEmail).deps);
    expect(mgr.ok).toBe(true);
    if (mgr.ok) expect(mgr.value[0]!.summary).toBe('disabled manager [email redacted]');

    const adm = await activityFeedQuery({ limit: 5 }, meta('admin'), ctx, depsReturning(withEmail).deps);
    expect(adm.ok).toBe(true);
    if (adm.ok) expect(adm.value[0]!.summary).toBe('disabled manager user@example.com');
  });

  it('clamps limit to the [1, 100] range', async () => {
    const { deps, recent } = depsReturning(MIXED);
    await activityFeedQuery({ limit: 500 }, meta('admin'), ctx, deps);
    expect(recent).toHaveBeenCalledWith(ctx, 100);
    await activityFeedQuery({ limit: 0 }, meta('manager'), ctx, deps);
    expect(recent).toHaveBeenCalledWith(ctx, 1);
  });

  it('defaults to 20 when no limit is given', async () => {
    const { deps, recent } = depsReturning(MIXED);
    await activityFeedQuery({}, meta('admin'), ctx, deps);
    expect(recent).toHaveBeenCalledWith(ctx, 20);
  });
});
