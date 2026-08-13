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

function depsReturning(
  items: readonly ActivityFeedItem[],
  identities: ReadonlyMap<string, { displayName: string | null }> = new Map(),
): {
  deps: { activitySource: ActivityFeedSource; actorDirectory: { labelsFor: ReturnType<typeof vi.fn> } };
  recent: ReturnType<typeof vi.fn>;
  labelsFor: ReturnType<typeof vi.fn>;
} {
  const recent = vi.fn().mockResolvedValue(items);
  const labelsFor = vi.fn().mockResolvedValue(identities);
  return { deps: { activitySource: { recent }, actorDirectory: { labelsFor } }, recent, labelsFor };
}

describe('activityFeedQuery', () => {
  it('forbids members without reading the source', async () => {
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery({ limit: 10 }, meta('member'), ctx, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('forbidden');
    expect(recent).not.toHaveBeenCalled();
  });

  // `activityUnredacted` is set explicitly on both cases below to the value the
  // page derives for that role (admin holds `insights.activity_unredacted`,
  // manager does not). `depsReturning` omits the field, so these two ran the
  // REDACTED branch and passed only because the MIXED fixture happens to carry
  // no email or phone — two tests named for a path neither of them walked.
  it('admin sees the full feed (incl. finance events), fetching exactly `limit`', async () => {
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery(
      { limit: 10 },
      meta('admin'),
      ctx,
      { ...deps, activityUnredacted: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((e) => e.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(recent).toHaveBeenCalledWith(ctx, 10);
  });

  it('manager sees the SAME full feed as admin incl. finance events (FR-007)', async () => {
    // The "read-only on finance" manager may VIEW finance figures, so the feed
    // no longer drops payment/invoice/refund events for managers.
    const { deps, recent } = depsReturning(MIXED);
    const result = await activityFeedQuery(
      { limit: 10 },
      meta('manager'),
      ctx,
      // Redaction and finance visibility are INDEPENDENT axes: a manager reads
      // the feed redacted, and still sees every money event in it.
      { ...deps, activityUnredacted: false },
    );
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
    // 016 T058 — the flags below are what the composition root computes for
    // these two roles from `insights.activity_unredacted`; the roles are kept
    // in the test names because R001 is about those personas' projections.
    const mgr = await activityFeedQuery({ limit: 5 }, meta('manager'), ctx, {
      ...depsReturning(withEmail).deps,
      activityUnredacted: false,
    });
    expect(mgr.ok).toBe(true);
    if (mgr.ok) expect(mgr.value[0]!.summary).toBe('disabled manager [email redacted]');

    const adm = await activityFeedQuery({ limit: 5 }, meta('admin'), ctx, {
      ...depsReturning(withEmail).deps,
      activityUnredacted: true,
    });
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

  it('resolves the actor display name for a UUID actor (FR-003)', async () => {
    const actorId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const feed: readonly ActivityFeedItem[] = [
      { ...item('1', 'member_created'), actorUserId: actorId },
    ];
    const { deps, labelsFor } = depsReturning(
      feed,
      new Map([[actorId, { displayName: 'Jane Doe' }]]),
    );
    const result = await activityFeedQuery({ limit: 5 }, meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]!.actorLabel).toBe('Jane Doe');
    // Batch-resolved via the PDPA-safe directory.
    expect(labelsFor).toHaveBeenCalledWith([actorId]);
  });

  it('passes the target record ref through for the related-record link (FR-003)', async () => {
    const targetId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const feed: readonly ActivityFeedItem[] = [
      { ...item('1', 'member_updated'), targetUserId: targetId },
    ];
    const result = await activityFeedQuery({ limit: 5 }, meta('admin'), ctx, depsReturning(feed).deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]!.targetUserId).toBe(targetId);
  });

  it('leaves actorLabel null for a system/non-UUID actor (no resolve attempt)', async () => {
    const feed: readonly ActivityFeedItem[] = [
      { ...item('1', 'broadcast_dispatched'), actorUserId: 'system:cron' },
    ];
    const { deps, labelsFor } = depsReturning(feed);
    const result = await activityFeedQuery({ limit: 5 }, meta('admin'), ctx, deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]!.actorLabel).toBeNull();
    // system:* sentinels are never sent to the PDPA-safe resolver.
    expect(labelsFor).not.toHaveBeenCalled();
  });
});

/**
 * 016 T058 (US3) — the redaction decision is keyed on
 * `insights.activity_unredacted`, not on membership of the administrative role
 * set.
 *
 * The two populations are identical TODAY, which is why this task is a
 * restatement rather than a behaviour change (T034). They stop being identical
 * the moment the bundles move: granting `insights.activity_unredacted` to a
 * non-administrative role would leave a role-set check still redacting, and
 * removing it from `admin` would leave that check still handing over the raw
 * summary. The second direction is the dangerous one — this suite pins both.
 *
 * `unredacted` is INJECTED for the same reason as `canFinance` in
 * `listDashboard`: the Application layer must not re-derive the permission
 * model, and the composition root already owns `canPerform`.
 */
describe('activityFeedQuery redaction is permission-keyed (T058)', () => {
  const WITH_EMAIL: readonly ActivityFeedItem[] = [
    { ...item('1', 'user_invited'), summary: 'invited nina@example.com as manager' },
  ];

  it('redacts the summary when the viewer lacks the key', async () => {
    const result = await activityFeedQuery(
      { limit: 5 },
      meta('marketing'),
      ctx,
      { ...depsReturning(WITH_EMAIL).deps, activityUnredacted: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.summary).not.toContain('nina@example.com');
  });

  it('leaves the summary intact when the viewer holds the key', async () => {
    const result = await activityFeedQuery(
      { limit: 5 },
      meta('admin'),
      ctx,
      { ...depsReturning(WITH_EMAIL).deps, activityUnredacted: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.summary).toContain('nina@example.com');
  });

  it('follows the KEY, not the role — a non-administrative holder is not redacted', async () => {
    // The assertion a role-set check cannot pass: `manager` sits outside the
    // administrative set, so `isAdministrativeRole` would redact regardless of
    // what the bundle says.
    const result = await activityFeedQuery(
      { limit: 5 },
      meta('manager'),
      ctx,
      { ...depsReturning(WITH_EMAIL).deps, activityUnredacted: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.summary).toContain('nina@example.com');
  });

  it('follows the KEY in the other direction — an administrative non-holder IS redacted', async () => {
    // The dangerous direction: an `admin` whose bundle no longer carries the
    // key must lose the raw summary. A role-set check would hand it over.
    const result = await activityFeedQuery(
      { limit: 5 },
      meta('admin'),
      ctx,
      { ...depsReturning(WITH_EMAIL).deps, activityUnredacted: false },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.summary).not.toContain('nina@example.com');
  });

  it('defaults to REDACTED when the dep is omitted (fail-closed)', async () => {
    // A caller that forgets to thread the flag must get the safe projection,
    // never the raw one — the opposite default would turn an oversight in a new
    // call site into a PII leak.
    const result = await activityFeedQuery(
      { limit: 5 },
      meta('admin'),
      ctx,
      depsReturning(WITH_EMAIL).deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.summary).not.toContain('nina@example.com');
  });
});
