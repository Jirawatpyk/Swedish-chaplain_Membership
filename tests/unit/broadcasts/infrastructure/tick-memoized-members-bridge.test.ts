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
  contactCalls: Array<{ type: string; params: unknown }>;
  haltCalls: Array<{ memberId: string; halted: boolean }>;
  primaryCalls: Array<{ memberId: string }>;
} {
  const segmentCalls: Array<{ type: string; params: unknown }> = [];
  const contactCalls: Array<{ type: string; params: unknown }> = [];
  const haltCalls: Array<{ memberId: string; halted: boolean }> = [];
  const primaryCalls: Array<{ memberId: string }> = [];
  const bridge: MembersBridgePort = {
    async getMembersBySegment(_ctx, type, params) {
      segmentCalls.push({ type, params });
      return [makeRecipient('m-1')];
    },
    // 108 PR-C — the 1:N page walk; memoised per tick like the member leg.
    async getContactsBySegment(_ctx, type, params) {
      contactCalls.push({ type, params });
      return [
        {
          memberId: 'm-1',
          contactId: 'c-1',
          emailLower: unsafeBrandEmailLower('c-1@example.com'),
          isPrimary: true,
        },
      ];
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
    async filterMarketingOptedOut() { return new Set(); },
    async getMemberPreferredLocale() {
      return null;
    },
  };
  return { bridge, segmentCalls, contactCalls, haltCalls, primaryCalls };
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
    await memo.setMemberHalt(tenant, 'mem-1', true, 'system');
    await memo.setMemberHalt(tenant, 'mem-1', true, 'system');
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

describe('makeTickMemoizedMembersBridge — filterMarketingOptedOut is NOT memoized (cycle 15)', () => {
  it('forwards every call to the inner bridge and returns its answer', async () => {
    // A contact can opt out mid-tick; a cached answer would send to them
    // anyway. Only `getMembersBySegment` is cached per tick.
    const calls: Array<ReadonlyArray<string>> = [];
    const inner: MembersBridgePort = {
      ...makeStubBridge().bridge,
      async filterMarketingOptedOut(_ctx, emails) {
        calls.push(emails as unknown as ReadonlyArray<string>);
        return new Set([emails[0]!]);
      },
    };
    const bridge = makeTickMemoizedMembersBridge(inner);
    const batch = [unsafeBrandEmailLower('a@example.com'), unsafeBrandEmailLower('b@example.com')];
    const first = await bridge.filterMarketingOptedOut(tenant, batch);
    const second = await bridge.filterMarketingOptedOut(tenant, batch);
    expect(calls).toHaveLength(2);
    expect([...first]).toEqual(['a@example.com']);
    expect([...second]).toEqual(['a@example.com']);
  });
});

describe('makeTickMemoizedMembersBridge — getContactsBySegment is memoized per tick (108 PR-C T075)', () => {
  it('cache hit: identical (tenant, segmentType, params) → the inner bridge walks the pages ONCE', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    const a = await memo.getContactsBySegment(tenant, 'all_members', {});
    const b = await memo.getContactsBySegment(tenant, 'all_members', {});
    expect(stub.contactCalls).toHaveLength(1);
    expect(a).toBe(b);
  });

  it('tierCodes sort normalises the key; a different tenant is a different slot', async () => {
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    await memo.getContactsBySegment(tenant, 'tier', { tierCodes: ['B', 'A'] });
    await memo.getContactsBySegment(tenant, 'tier', { tierCodes: ['A', 'B'] });
    expect(stub.contactCalls).toHaveLength(1);
    await memo.getContactsBySegment(asTenantContext('other-tenant'), 'tier', { tierCodes: ['A', 'B'] });
    expect(stub.contactCalls).toHaveLength(2);
  });

  it('the member-level and contact-level caches never share a slot: the same segment asked both ways runs both', async () => {
    // A `MemberRecipient[]` handed to a caller expecting `ContactRecipient[]`
    // would resolve to ZERO recipients (no `emailLower` field) — exactly the
    // silent-empty class research R8 exists to close.
    const stub = makeStubBridge();
    const memo = makeTickMemoizedMembersBridge(stub.bridge);
    const memberRows = await memo.getMembersBySegment(tenant, 'all_members', {});
    const contactRows = await memo.getContactsBySegment(tenant, 'all_members', {});
    expect(stub.segmentCalls).toHaveLength(1);
    expect(stub.contactCalls).toHaveLength(1);
    expect(contactRows as unknown).not.toBe(memberRows as unknown);
    expect(contactRows[0]).toMatchObject({ contactId: 'c-1', emailLower: 'c-1@example.com' });
  });
});
