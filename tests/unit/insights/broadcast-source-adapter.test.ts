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

  it('reports the newest sent broadcast date when used>0', async () => {
    computeQuotaMock.mockResolvedValueOnce(ok({ counter: { used: 2 } }));
    listMemberBroadcastsMock.mockResolvedValueOnce({
      rows: [
        { status: 'sent', sentAt: new Date('2026-05-10T00:00:00.000Z') },
        { status: 'sent', sentAt: new Date('2026-02-01T00:00:00.000Z') },
        { status: 'draft', sentAt: null },
      ],
    });
    const r = await broadcastSourceAdapter.getEblastConsumption(CTX, 'm1', 2026);
    expect(r.used).toBe(2);
    expect(r.lastUsedAt).toBe('2026-05-10T00:00:00.000Z');
  });
});
