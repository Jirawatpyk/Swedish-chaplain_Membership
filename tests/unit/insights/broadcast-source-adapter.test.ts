/**
 * F9 US4 (review-run R2 T-1) — broadcastSourceAdapter.getEblastConsumption
 * fail-loud contract.
 *
 * The load-bearing C-1 invariant: when computeQuotaCounter returns `!ok` (a DB
 * fault laundered through the F7 plan bridge into member_not_found, or an
 * invariant violation), the adapter MUST throw — never return `used: 0`, which
 * would fire a false under-use warning. A genuine free-tier / no-usage member
 * returns `ok({ used: 0 })` and must NOT throw. We mock the broadcasts barrel
 * to drive both outcomes.
 */
import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';

const computeQuotaMock = vi.fn();
const listMemberBroadcastsMock = vi.fn();

vi.mock('@/modules/broadcasts', () => ({
  makeBroadcastApprovalCounter: () => ({ countAwaitingApproval: async () => 0 }),
  computeQuotaCounter: (...a: unknown[]) => computeQuotaMock(...a),
  makeComputeQuotaDeps: () => ({}),
  listMemberBroadcasts: (...a: unknown[]) => listMemberBroadcastsMock(...a),
  makeListMemberBroadcastsDeps: () => ({}),
}));
vi.mock('@/modules/members', () => ({ asMemberId: (s: string) => s }));
vi.mock('@/lib/env', () => ({ env: { tenant: { timezone: 'Asia/Bangkok' } } }));

import { broadcastSourceAdapter } from '@/modules/insights/infrastructure/sources/broadcast-source-adapter';

const CTX = { slug: 'test-tenant' } as unknown as TenantContext;

describe('broadcastSourceAdapter.getEblastConsumption — fail-loud (C-1)', () => {
  it('throws (does NOT return used:0) when computeQuotaCounter fails', async () => {
    computeQuotaMock.mockResolvedValueOnce(err({ kind: 'quota.member_not_found', memberId: 'm1' }));
    await expect(
      broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026),
    ).rejects.toThrow(/eblast consumption lookup failed/i);
  });

  it('returns used:0 (no throw) for a genuine zero-usage member', async () => {
    computeQuotaMock.mockResolvedValueOnce(ok({ counter: { used: 0 } }));
    const r = await broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026);
    expect(r).toEqual({ used: 0, lastUsedAt: null });
    // used===0 short-circuits the last-sent scan.
    expect(listMemberBroadcastsMock).not.toHaveBeenCalled();
  });

  it('over-subscription (used+reserved>cap, e.g. plan downgrade) → renders the real used, no throw', async () => {
    // The real member b317dece case: 0 sent, 2 reserved, cap 1. Must render the
    // benefit view (used 0 of 1), not break it with a throw (insights bug-fix).
    computeQuotaMock.mockResolvedValueOnce(
      err({
        kind: 'quota.invariant_violation',
        cause: { code: 'quota_counter.over_subscription', used: 0, reserved: 2, cap: 1 },
      }),
    );
    const r = await broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026);
    expect(r).toEqual({ used: 0, lastUsedAt: null });
    expect(listMemberBroadcastsMock).not.toHaveBeenCalled();
  });

  it('over-subscription surfaces the cause’s real sent count (used>0) and never throws', async () => {
    computeQuotaMock.mockResolvedValueOnce(
      err({
        kind: 'quota.invariant_violation',
        cause: { code: 'quota_counter.over_subscription', used: 2, reserved: 1, cap: 1 },
      }),
    );
    const r = await broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026);
    expect(r).toEqual({ used: 2, lastUsedAt: null });
    // The over-subscription read returns directly (no last-sent scan).
    expect(listMemberBroadcastsMock).not.toHaveBeenCalled();
  });

  it('reports the newest sent broadcast date when used>0', async () => {
    computeQuotaMock.mockResolvedValueOnce(ok({ counter: { used: 2 } }));
    listMemberBroadcastsMock.mockResolvedValueOnce({
      rows: [
        { status: 'sent', sentAt: new Date('2026-05-10T00:00:00.000Z'), partialDeliveryAcceptedAt: null },
        { status: 'sent', sentAt: new Date('2026-02-01T00:00:00.000Z'), partialDeliveryAcceptedAt: null },
        { status: 'draft', sentAt: null, partialDeliveryAcceptedAt: null },
      ],
    });
    const r = await broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026);
    expect(r.used).toBe(2);
    expect(r.lastUsedAt).toBe('2026-05-10T00:00:00.000Z');
  });

  // FR-008c (finding C-followup) — a partial-accept-only member: used>0 (the
  // already-fixed countForMemberQuota counts `partial_delivery_accepted`), but
  // the row has NO `sentAt`; its only usage timestamp is
  // `partialDeliveryAcceptedAt`. Pre-fix the scan guarded `status !== 'sent'`
  // → null lastUsedAt ("used, but never used"). Post-fix it coalesces.
  it('coalesces partialDeliveryAcceptedAt for a partial-accept-only member (no sentAt)', async () => {
    computeQuotaMock.mockResolvedValueOnce(ok({ counter: { used: 1 } }));
    listMemberBroadcastsMock.mockResolvedValueOnce({
      rows: [
        {
          status: 'partial_delivery_accepted',
          sentAt: null,
          partialDeliveryAcceptedAt: new Date('2026-04-20T00:00:00.000Z'),
        },
      ],
    });
    const r = await broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026);
    expect(r.used).toBe(1);
    expect(r.lastUsedAt).toBe('2026-04-20T00:00:00.000Z');
  });

  // The newest usage timestamp across BOTH terminal states wins (sent and
  // partial-accept are interleaved; the latest instant — here a partial-accept
  // — is reported regardless of which state it belongs to).
  it('reports the newest usage instant across sent + partial-accepted rows', async () => {
    computeQuotaMock.mockResolvedValueOnce(ok({ counter: { used: 2 } }));
    listMemberBroadcastsMock.mockResolvedValueOnce({
      rows: [
        { status: 'sent', sentAt: new Date('2026-03-01T00:00:00.000Z'), partialDeliveryAcceptedAt: null },
        {
          status: 'partial_delivery_accepted',
          sentAt: null,
          partialDeliveryAcceptedAt: new Date('2026-06-15T00:00:00.000Z'),
        },
      ],
    });
    const r = await broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026);
    expect(r.used).toBe(2);
    expect(r.lastUsedAt).toBe('2026-06-15T00:00:00.000Z');
  });
});
