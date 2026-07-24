/**
 * Task 9 (renewal-rolling-anchor design 2026-07-08 §3b) —
 * `loadMemberRenewalContext` unit spec.
 *
 * Covers: classification mapping for all 5 classifier outcomes (renewal /
 * first_payment / heal_no_cycle / not_applicable:erased /
 * not_applicable:terminal_only), periodTo+termMonths window derivation
 * (ONLY set for `renewal`), and tenant-scoped call shape
 * (`runInTenant` + the repo methods receive `(tx, tenantId, memberId)`).
 *
 * `@/lib/db`'s `runInTenant` is mocked at the seam (same pattern as
 * `events-admin-deps-tin-presence.test.ts`) so no live Neon is needed;
 * `@/modules/renewals`'s `classifyMembershipPayment` is the REAL pure
 * domain function (only `makeRenewalsDeps` is swapped for a fake repo
 * pair) so this test also pins the classifier wiring, not just the mock.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';

const runInTenantMock = vi.hoisted(() => vi.fn());
const countCyclesMock = vi.hoisted(() => vi.fn());
const countSettledCyclesMock = vi.hoisted(() => vi.fn());
const findOpenCycleMock = vi.hoisted(() => vi.fn());
const readGuardsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  runInTenant: runInTenantMock,
}));

vi.mock('@/modules/renewals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/renewals')>();
  return {
    ...actual,
    makeRenewalsDeps: () => ({
      cyclesRepo: {
        countCyclesForMemberInTx: countCyclesMock,
        countSettledCyclesForMemberInTx: countSettledCyclesMock,
        findOpenCycleForMemberInTx: findOpenCycleMock,
      },
      memberRenewalFlagsRepo: {
        readReactivationGuardsInTx: readGuardsMock,
      },
    }),
  };
});

import { loadMemberRenewalContext } from '@/app/(staff)/admin/invoices/_lib/member-renewal-context';

const TENANT_SLUG = 'test-swecham';
const MEMBER_ID = '00000000-0000-4000-8000-000000000001';
const SENTINEL_TX = { sentinel: 'tx' } as never;

function buildOpenCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return {
    tenantId: TENANT_SLUG,
    cycleId: asCycleId('00000000-0000-0000-0000-000000000c01'),
    memberId: MEMBER_ID,
    status: 'upcoming' as const,
    periodFrom: '2026-06-01T00:00:00Z',
    periodTo: '2027-06-01T00:00:00Z',
    expiresAt: '2027-06-01T00:00:00Z',
    cycleLengthMonths: 12,
    tierAtCycleStart: 'regular' as const,
    planIdAtCycleStart: 'p1',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB' as const,
    enteredPendingAt: null,
    linkedInvoiceId: null,
    linkedCreditNoteId: null,
    anchoredAt: '2026-06-01T00:00:00Z',
    anchorInvoiceId: '00000000-0000-0000-0000-0000000aaaaa',
    closedAt: null,
    closedReason: null,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...overrides,
  } as RenewalCycle;
}

beforeEach(() => {
  vi.clearAllMocks();
  runInTenantMock.mockImplementation(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn(SENTINEL_TX),
  );
  readGuardsMock.mockResolvedValue({ blocked: false, erased: false });
  countCyclesMock.mockResolvedValue(0);
  // F2 fix (final-review, 2026-07-09) — default 0 (no settled predecessor).
  // Only consulted when an open cycle exists (see the implementation's
  // conditional fetch) — most tests below leave `findOpenCycleMock` at its
  // `null` default and never reach this read at all.
  countSettledCyclesMock.mockResolvedValue(0);
  findOpenCycleMock.mockResolvedValue(null);
});

describe('loadMemberRenewalContext — classification mapping', () => {
  it('heal_no_cycle — zero cycles ever → periodTo/termMonths stay null', async () => {
    countCyclesMock.mockResolvedValue(0);
    findOpenCycleMock.mockResolvedValue(null);

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'heal_no_cycle' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
    // 064 — no open cycle → no current period to bill.
    expect(out.currentPeriodFrom).toBeNull();
    expect(out.currentPeriodTo).toBeNull();
  });

  it('first_payment — one un-anchored open cycle → periodTo/termMonths null BUT currentPeriod surfaced (064)', async () => {
    countCyclesMock.mockResolvedValue(1);
    findOpenCycleMock.mockResolvedValue(
      buildOpenCycle({ status: 'upcoming', anchoredAt: null }),
    );

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'first_payment' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
    // 064 — the open cycle's CURRENT period is surfaced for a first payment so
    // the New-invoice route can bill it as the §86/4 coverage window. This is
    // the feature's core mapping (`openCycle.periodFrom/periodTo`) — it must NOT
    // be gated behind `classification === 'renewal'`.
    expect(out.currentPeriodFrom).toBe('2026-06-01T00:00:00Z');
    expect(out.currentPeriodTo).toBe('2027-06-01T00:00:00Z');
  });

  it('renewal — 2nd+ cycle already anchored → periodTo + termMonths surfaced from the open cycle', async () => {
    countCyclesMock.mockResolvedValue(2);
    findOpenCycleMock.mockResolvedValue(
      buildOpenCycle({
        status: 'awaiting_payment',
        anchoredAt: '2026-06-01T00:00:00Z',
        periodTo: '2027-06-01T00:00:00Z',
        frozenPlanTermMonths: 12,
      }),
    );

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'renewal' });
    expect(out.periodTo).toBe('2027-06-01T00:00:00Z');
    expect(out.termMonths).toBe(12);
    // 064 — the current period is surfaced for a renewal too (the route uses the
    // renewal-specific periodTo+term for the NEXT period, but currentPeriod is
    // still populated whenever an open cycle exists).
    expect(out.currentPeriodFrom).toBe('2026-06-01T00:00:00Z');
    expect(out.currentPeriodTo).toBe('2027-06-01T00:00:00Z');
    // R2-FIX-9 — with a known open cycle the dead count-all read is skipped.
    expect(countCyclesMock).not.toHaveBeenCalled();
  });

  // F2 fix (final-review, 2026-07-09) — a predecessor cycle that was
  // cancelled/lapsed WITHOUT ever anchoring (genuinely never paid) must
  // NOT count as "renewal history".
  it('first_payment — predecessor cycle exists but was NEVER settled → still first_payment (not renewal)', async () => {
    countCyclesMock.mockResolvedValue(2);
    countSettledCyclesMock.mockResolvedValue(0);
    findOpenCycleMock.mockResolvedValue(
      buildOpenCycle({ status: 'upcoming', anchoredAt: null }),
    );

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'first_payment' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });

  it('not_applicable:erased — GDPR-erased member, regardless of cycle history', async () => {
    readGuardsMock.mockResolvedValue({ blocked: false, erased: true });
    countCyclesMock.mockResolvedValue(3);
    findOpenCycleMock.mockResolvedValue(buildOpenCycle());

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'not_applicable', reason: 'erased' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });

  it('not_applicable:terminal_only — cycles exist but none open', async () => {
    countCyclesMock.mockResolvedValue(2);
    findOpenCycleMock.mockResolvedValue(null);

    const out = await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(out.classification).toEqual({ kind: 'not_applicable', reason: 'terminal_only' });
    expect(out.periodTo).toBeNull();
    expect(out.termMonths).toBeNull();
  });
});

describe('loadMemberRenewalContext — tenant-scoped call shape', () => {
  it('threads (tx, tenantId, memberId) into both cyclesRepo reads + the guards read', async () => {
    await loadMemberRenewalContext(TENANT_SLUG, MEMBER_ID);

    expect(runInTenantMock).toHaveBeenCalledTimes(1);
    expect(readGuardsMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_SLUG, MEMBER_ID);
    expect(countCyclesMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_SLUG, MEMBER_ID);
    expect(findOpenCycleMock).toHaveBeenCalledWith(SENTINEL_TX, TENANT_SLUG, MEMBER_ID);
  });
});
