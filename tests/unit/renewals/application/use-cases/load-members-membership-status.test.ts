import { describe, expect, it, vi } from 'vitest';
import { loadMembersMembershipStatus } from '@/modules/renewals';
import type { RenewalCycle } from '@/modules/renewals';

const NOW = new Date('2026-06-06T00:00:00.000Z');
const clock = { now: () => NOW };

function cycle(overrides: Partial<RenewalCycle>): RenewalCycle {
  return {
    tenantId: 't', cycleId: 'c', memberId: 'm', status: 'awaiting_payment',
    periodFrom: '2026-01-01T00:00:00.000Z', periodTo: '2027-01-01T00:00:00.000Z',
    expiresAt: '2027-01-01T00:00:00.000Z', cycleLengthMonths: 12, tierAtCycleStart: 'regular',
    planIdAtCycleStart: 'p', frozenPlanPriceThb: '50000.00', frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB', linkedCreditNoteId: null, anchoredAt: null, anchorInvoiceId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', closedAt: null, closedReason: null, linkedInvoiceId: null,
    enteredPendingAt: null, ...overrides,
  } as RenewalCycle;
}

describe('loadMembersMembershipStatus', () => {
  it('returns the lapsed AND suspended member ids in SEPARATE sets', async () => {
    const repo = {
      findLatestCyclesForMembers: vi.fn().mockResolvedValue([
        cycle({ memberId: 'lapsed-1', status: 'lapsed', closedAt: '2026-01-01T00:00:00.000Z', closedReason: 'lapsed', expiresAt: '2026-01-01T00:00:00.000Z' }),
        cycle({ memberId: 'suspended-1', status: 'awaiting_payment', expiresAt: '2027-01-01T00:00:00.000Z' }),
        cycle({ memberId: 'completed-1', status: 'completed', closedAt: '2026-01-01T00:00:00.000Z', closedReason: 'paid', linkedInvoiceId: 'i', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ]),
    };
    const res = await loadMembersMembershipStatus(
      { cyclesRepo: repo as never, clock },
      { tenantId: 't', memberIds: ['lapsed-1', 'suspended-1', 'completed-1', 'no-cycle'] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect([...res.value.lapsed].sort()).toEqual(['lapsed-1']);
      expect([...res.value.suspended].sort()).toEqual(['suspended-1']);
    }
  });

  it('an awaiting_payment (unpaid) member is in the suspended set, NOT lapsed', async () => {
    const repo = {
      findLatestCyclesForMembers: vi.fn().mockResolvedValue([
        cycle({ memberId: 'm1', status: 'awaiting_payment', expiresAt: '2027-01-01T00:00:00.000Z' }),
      ]),
    };
    const res = await loadMembersMembershipStatus(
      { cyclesRepo: repo as never, clock },
      { tenantId: 't', memberIds: ['m1'] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.suspended.has('m1')).toBe(true);
      expect(res.value.lapsed.has('m1')).toBe(false);
    }
  });

  it('a lapsed/cancelled-expired member is in the lapsed set, NOT suspended', async () => {
    const repo = {
      findLatestCyclesForMembers: vi.fn().mockResolvedValue([
        cycle({ memberId: 'm2', status: 'cancelled', closedAt: '2026-01-01T00:00:00.000Z', closedReason: 'cancelled', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ]),
    };
    const res = await loadMembersMembershipStatus(
      { cyclesRepo: repo as never, clock },
      { tenantId: 't', memberIds: ['m2'] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.lapsed.has('m2')).toBe(true);
      expect(res.value.suspended.has('m2')).toBe(false);
    }
  });

  it('a completed member is in NEITHER set', async () => {
    const repo = {
      findLatestCyclesForMembers: vi.fn().mockResolvedValue([
        cycle({ memberId: 'm3', status: 'completed', closedAt: '2026-01-01T00:00:00.000Z', closedReason: 'paid', linkedInvoiceId: 'i', expiresAt: '2026-01-01T00:00:00.000Z' }),
      ]),
    };
    const res = await loadMembersMembershipStatus(
      { cyclesRepo: repo as never, clock },
      { tenantId: 't', memberIds: ['m3'] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.lapsed.has('m3')).toBe(false);
      expect(res.value.suspended.has('m3')).toBe(false);
    }
  });

  it('short-circuits empty input WITHOUT calling the repo', async () => {
    const repo = { findLatestCyclesForMembers: vi.fn() };
    const res = await loadMembersMembershipStatus(
      { cyclesRepo: repo as never, clock },
      { tenantId: 't', memberIds: [] },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.lapsed.size).toBe(0);
      expect(res.value.suspended.size).toBe(0);
    }
    expect(repo.findLatestCyclesForMembers).not.toHaveBeenCalled();
  });

  it('propagates a repo throw (the page wrapper degrades it to empty)', async () => {
    const repo = { findLatestCyclesForMembers: vi.fn().mockRejectedValue(new Error('db down')) };
    await expect(
      loadMembersMembershipStatus(
        { cyclesRepo: repo as never, clock },
        { tenantId: 't', memberIds: ['m1'] },
      ),
    ).rejects.toThrow('db down');
  });
});
