/**
 * R7 staff-review LOW-B fix — unit test for `makeTickMemoizedMembersBridge`.
 *
 * The factory was added in R6 W-P3 (commit `28cc851`) and wraps the
 * F3 `MembersBridgePort` with a per-tick segment-resolution cache so
 * the cron dispatch loop doesn't re-resolve `all_members` once per
 * broadcast. Without these tests, a regression that drops the Map
 * cache (or breaks the tier-codes sort that prevents key collisions)
 * would silently revert the perf fix — visible only in production
 * trace latency.
 */
import { describe, expect, it } from 'vitest';
import { makeTickMemoizedMembersBridge } from '@/modules/broadcasts';
import type {
  MemberRecipient,
  MembersBridgePort,
} from '@/modules/broadcasts/application/ports/members-bridge-port';
import { asTenantContext } from '@/modules/tenants';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { ok } from '@/lib/result';

function makeRecipient(memberId: string): MemberRecipient {
  return {
    memberId,
    displayName: `Member ${memberId}`,
    primaryContactEmail: unsafeBrandEmailLower(`${memberId}@example.com`),
    tierCode: 'premium',
    broadcastsHaltedUntilAdminReview: false,
  };
}

function makeStubBridge(): {
  bridge: MembersBridgePort;
  segmentCalls: Array<{ type: string; params: unknown }>;
  haltCalls: Array<{ memberId: string; halted: boolean }>;
  primaryCalls: Array<{ memberId: string }>;
} {
  const segmentCalls: Array<{ type: string; params: unknown }> = [];
  const haltCalls: Array<{ memberId: string; halted: boolean }> = [];
  const primaryCalls: Array<{ memberId: string }> = [];
  const bridge: MembersBridgePort = {
    async getMembersBySegment(_ctx, type, params) {
      segmentCalls.push({ type, params });
      return [makeRecipient('m-1')];
    },
    async getMemberPrimaryContact(_ctx, memberId) {
      primaryCalls.push({ memberId });
      return unsafeBrandEmailLower(`${memberId}@example.com`);
    },
    async memberExistsInTenant() {
      return true;
    },
    async lookupContactEmailInTenant() {
      return null;
    },
    async lookupMemberPrimaryContactEmailInTenant() {
      return null;
    },
    async getMembersHaltedInTenant() {
      return [];
    },
    async setMemberHalt(_ctx, memberId, halted) {
      haltCalls.push({ memberId, halted });
      return ok(undefined);
    },
    async markBroadcastsAcknowledged() {
      return ok({ previouslyNull: true });
    },
    async getMemberPreferredLocale() {
      return null;
    },
  };
  return { bridge, segmentCalls, haltCalls, primaryCalls };
}

const tenant = asTenantContext('test-tenant');

describe('makeTickMemoizedMembersBridge (R7 LOW-B)', () => {
  it('cache hit: identical (segmentType, params) → second call does NOT hit inner bridge', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    await memo.getMembersBySegment(tenant, 'all_members', {});
    await memo.getMembersBySegment(tenant, 'all_members', {});
    expect(stub.segmentCalls).toHaveLength(1);
  });

  it('cache miss: different segmentType → independent calls', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    await memo.getMembersBySegment(tenant, 'all_members', {});
    await memo.getMembersBySegment(tenant, 'tier', { tierCodes: ['premium'] });
    expect(stub.segmentCalls).toHaveLength(2);
  });

  it('tierCodes sort: ["A","B"] and ["B","A"] hit the same cache slot', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    await memo.getMembersBySegment(tenant, 'tier', { tierCodes: ['B', 'A'] });
    await memo.getMembersBySegment(tenant, 'tier', { tierCodes: ['A', 'B'] });
    // Both calls normalize to the same sorted key, so the inner
    // bridge runs ONCE.
    expect(stub.segmentCalls).toHaveLength(1);
  });

  it('cache scope: different tenant slugs do NOT collide', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    await memo.getMembersBySegment(tenant, 'all_members', {});
    await memo.getMembersBySegment(asTenantContext('other-tenant'), 'all_members', {});
    expect(stub.segmentCalls).toHaveLength(2);
  });

  it('passes through non-cached methods (setMemberHalt) on every call', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    await memo.setMemberHalt(tenant, 'mem-1', true);
    await memo.setMemberHalt(tenant, 'mem-1', true);
    expect(stub.haltCalls).toHaveLength(2);
  });

  it('passes through non-cached methods (getMemberPrimaryContact) on every call', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    await memo.getMemberPrimaryContact(tenant, 'mem-1');
    await memo.getMemberPrimaryContact(tenant, 'mem-1');
    expect(stub.primaryCalls).toHaveLength(2);
  });

  it('returns the cached result reference on hit (does not re-allocate)', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    const a = await memo.getMembersBySegment(tenant, 'all_members', {});
    const b = await memo.getMembersBySegment(tenant, 'all_members', {});
    // Same array reference confirms the Map returned the same value
    // (downstream code MUST treat as readonly — typed as
    // ReadonlyArray).
    expect(a).toBe(b);
  });

  it('fresh wrapper instance has fresh cache (per-tick scope)', async () => {
    const stub = makeStubBridge();
    const memo1 = makeTickMemoizedMembersBridge(stub.bridge);
    const memo2 = makeTickMemoizedMembersBridge(stub.bridge);
    await memo1.getMembersBySegment(tenant, 'all_members', {});
    await memo2.getMembersBySegment(tenant, 'all_members', {});
    // Two wrappers = two separate caches = two inner-bridge calls.
    expect(stub.segmentCalls).toHaveLength(2);
  });
});
