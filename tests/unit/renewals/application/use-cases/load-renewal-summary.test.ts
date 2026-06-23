/**
 * F8 Phase 5 Wave B · T121 spec — `loadRenewalSummary`.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadRenewalSummary } from '@/modules/renewals/application/use-cases/load-renewal-summary';
import type { BenefitConsumptionEntry } from '@/modules/renewals/application/use-cases/load-renewal-summary';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a121';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c121a';

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_UUID,
    status: 'awaiting_payment',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  emitImpl?: () => Promise<void>;
  /**
   * PR #24 review-fix Round 2 — `isFirstTimeRenewer` is wired via
   * `cyclesRepo.list({ statusFilter: ['completed'], pageSize: 1 })`.
   * Default mock returns an empty page so the happy-path test reads
   * `isFirstTimeRenewer === true`. Tests that need the veteran path
   * pass `priorCompletedCycles: [<one-cycle>]`.
   *
   * Pass `listImpl: 'throw'` to deliberately exercise the catch-block
   * fallback that defaults to `false` (FR-Round2: graceful degrade
   * keeps the page rendering even when the probe fails).
   */
  priorCompletedCycles?: ReadonlyArray<RenewalCycle>;
  listImpl?: 'throw';
  /**
   * `benefitConsumptionReader.read` mock behaviour. The reader is the
   * F8 → F9 bridge that feeds the cycle's metered benefit consumption.
   *
   *   - `undefined` (default) → reader returns `null` (no data → the
   *     page renders the neutral "unavailable" fallback). Matches the
   *     pre-wiring MVP behaviour so the existing happy-path assertions
   *     (`benefits === [] / benefitsAvailable === false`) still hold.
   *   - an array → reader returns that consumption list (available).
   *   - `'throw'` → reader rejects; the use-case must degrade
   *     gracefully to `[] / false` (NEVER turn the page into a 500).
   */
  benefitConsumption?:
    | ReadonlyArray<BenefitConsumptionEntry>
    | null
    | 'throw';
}): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
  listMock: ReturnType<typeof vi.fn>;
  benefitReadMock: ReturnType<typeof vi.fn>;
} {
  const findByIdMock = vi.fn(async () => args.cycle ?? null);
  const emitMock = vi.fn(args.emitImpl ?? (async () => {}));
  const listMock = vi.fn(async () => {
    if (args.listImpl === 'throw') {
      throw new Error('cyclesRepo.list: simulated probe failure');
    }
    return {
      items: args.priorCompletedCycles ?? [],
      nextCursor: null,
    };
  });
  const benefitReadMock = vi.fn(async () => {
    if (args.benefitConsumption === 'throw') {
      throw new Error('benefitConsumptionReader.read: simulated failure');
    }
    // `undefined` collapses to `null` so the default deps mirror the
    // pre-wiring "unavailable" behaviour.
    return args.benefitConsumption === undefined
      ? null
      : args.benefitConsumption;
  });
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findById: findByIdMock,
      list: listMock,
    },
    auditEmitter: {
      emit: emitMock,
      emitInTx: vi.fn(async () => {}),
    },
    benefitConsumptionReader: {
      read: benefitReadMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, emitMock, listMock, benefitReadMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: CYCLE_UUID,
  memberId: MEMBER_UUID,
  actorRole: 'member' as const,
  actorUserId: 'user-1',
  correlationId: 'corr-1',
};

describe('loadRenewalSummary (T121)', () => {
  it('happy path — returns frozen price + benefits empty + first-time TRUE for member with no prior completed cycles', async () => {
    // PR #24 review-fix Round 2 — isFirstTimeRenewer is now wired via
    // `cyclesRepo.list({ statusFilter: ['completed'] })`. With no prior
    // completed cycles in the mock list result, the member is genuinely
    // first-time; the use-case returns `true`.
    const cycle = buildCycle();
    const { deps, listMock } = fakeDeps({ cycle });
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.frozenPlanPriceThb).toBe('50000.00');
      expect(r.value.frozenPlanTermMonths).toBe(12);
      expect(r.value.frozenPlanCurrency).toBe('THB');
      expect(r.value.status).toBe('awaiting_payment');
      // Default `fakeDeps` wires the benefit reader to return `null`
      // (no upstream data) → the page renders the neutral fallback.
      expect(r.value.benefits).toEqual([]);
      expect(r.value.benefitsAvailable).toBe(false);
      expect(r.value.isFirstTimeRenewer).toBe(true);
    }
    // Confirm the probe ran with the right filter shape (statusFilter
    // = completed, memberIdFilter, pageSize:1, excludeCycleId = current
    // cycle) — defends against a future refactor accidentally widening
    // the probe OR dropping the self-exclusion guard. Without
    // `excludeCycleId` a member whose only cycle just turned completed
    // would self-count and lose the first-time-renewer banner.
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls[0]?.[1]).toMatchObject({
      pageSize: 1,
      memberIdFilter: MEMBER_UUID,
      statusFilter: ['completed'],
      excludeCycleId: CYCLE_UUID,
    });
  });

  it('isFirstTimeRenewer TRUE when current cycle is itself completed (self-exclusion guard)', async () => {
    // Regression guard for the post-Round 12 review finding: when the
    // summary is loaded for a cycle that is already in `completed`
    // status (e.g. member revisits the page after their first renewal
    // landed), the `isFirstTimeRenewer` probe MUST exclude the current
    // cycle from the count. Otherwise the probe finds the current
    // cycle as a "prior completed" cycle and silently flips the flag
    // to `false` for a genuine first-timer.
    //
    // Mock contract: the repo respects `excludeCycleId` and filters out
    // the matching cycleId. The mock below returns an empty list when
    // the only completed cycle in the test fixture is the current one,
    // mirroring the real Drizzle adapter (`ne(cycle_id, $1)`).
    const completedCurrent = buildCycle({ status: 'completed' });
    const findByIdMock = vi.fn(async () => completedCurrent);
    const listMock = vi.fn(async (_tenantId: string, opts: {
      readonly excludeCycleId?: string;
      readonly memberIdFilter?: string;
      readonly statusFilter?: ReadonlyArray<string>;
    }) => {
      // Real adapter behaviour: a `cycle_id <> $1` filter would exclude
      // the only completed cycle (the current one), leaving an empty
      // page. Here we hand-roll the same shape from the fixture.
      const allCompleted: ReadonlyArray<RenewalCycle> = [completedCurrent];
      const filtered = allCompleted.filter(
        (c) =>
          (!opts.excludeCycleId || c.cycleId !== opts.excludeCycleId) &&
          (!opts.memberIdFilter || c.memberId === opts.memberIdFilter) &&
          (!opts.statusFilter || opts.statusFilter.includes(c.status)),
      );
      return { items: filtered, nextCursor: null };
    });
    const deps = {
      tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
      cyclesRepo: { findById: findByIdMock, list: listMock },
      auditEmitter: { emit: vi.fn(), emitInTx: vi.fn() },
    } as unknown as RenewalsDeps;
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.isFirstTimeRenewer).toBe(true);
    expect(listMock.mock.calls[0]?.[1]).toMatchObject({
      excludeCycleId: CYCLE_UUID,
    });
  });

  it('isFirstTimeRenewer FALSE for veteran with prior completed cycle', async () => {
    // Member has at least one prior completed cycle → not first-time.
    // List mock returns one item; only existence matters.
    const currentCycle = buildCycle();
    const priorCompleted = buildCycle({
      cycleId: asCycleId('00000000-0000-0000-0000-0000000c000a'),
      status: 'completed',
    });
    const { deps } = fakeDeps({
      cycle: currentCycle,
      priorCompletedCycles: [priorCompleted],
    });
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.isFirstTimeRenewer).toBe(false);
  });

  it('isFirstTimeRenewer defaults to FALSE when probe throws (UX-review R5/C3 fail-safe)', async () => {
    // UX-review R5/C3 (2026-05-09): a false-negative (silent banner) is
    // preferable to a false-positive (5-year veteran sees "Welcome to
    // your first renewal"). The use-case wraps the probe in try/catch;
    // any DB-side failure resolves to `false`.
    const cycle = buildCycle();
    const { deps } = fakeDeps({ cycle, listImpl: 'throw' });
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.isFirstTimeRenewer).toBe(false);
  });

  it('summary_not_found + emits cross_tenant_probe audit when cycle is null', async () => {
    const { deps, emitMock } = fakeDeps({ cycle: null });
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('summary_not_found');
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'renewal_cross_tenant_probe',
      payload: { route: 'load-renewal-summary' },
    });
  });

  it('cross_member_probe — cycle.memberId mismatch + emits probe audit', async () => {
    const cycle = buildCycle({ memberId: '00000000-0000-0000-0000-000000000999' });
    const { deps, emitMock } = fakeDeps({ cycle });
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cross_member_probe') {
      expect(r.error.attemptedMemberId).toBe('00000000-0000-0000-0000-000000000999');
    }
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'renewal_cross_member_probe',
    });
  });

  it('audit emit failure does NOT mask summary_not_found result', async () => {
    const { deps } = fakeDeps({
      cycle: null,
      emitImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('summary_not_found');
  });

  it('invalid_input on malformed cycleId', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await loadRenewalSummary(deps, {
      ...baseInput,
      cycleId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('invalid_input on non-uuid memberId', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await loadRenewalSummary(deps, {
      ...baseInput,
      memberId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('admin actorRole — succeeds (admin previewing member view)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({ cycle });
    const r = await loadRenewalSummary(deps, {
      ...baseInput,
      actorRole: 'admin',
      actorUserId: 'admin-1',
    });
    expect(r.ok).toBe(true);
  });

  it('null actorUserId allowed (token-verified pre-signin path)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({ cycle });
    const r = await loadRenewalSummary(deps, {
      ...baseInput,
      actorUserId: null,
    });
    expect(r.ok).toBe(true);
  });

  describe('benefit-consumption wiring (F8 → F9 reuse)', () => {
    it('reader returns entries → benefits populated + benefitsAvailable TRUE', async () => {
      const consumption: ReadonlyArray<BenefitConsumptionEntry> = [
        { key: 'eblast', used: 2, quota: 6 },
        { key: 'cultural_ticket', used: 0, quota: 4 },
      ];
      const cycle = buildCycle();
      const { deps, benefitReadMock } = fakeDeps({
        cycle,
        benefitConsumption: consumption,
      });
      const r = await loadRenewalSummary(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.benefitsAvailable).toBe(true);
        expect(r.value.benefits).toEqual(consumption);
      }
      // The reader is called with (tenantId, cycle.memberId) — the
      // cycle's memberId is the source of truth (it equals input.memberId
      // past the cross-member guard).
      expect(benefitReadMock).toHaveBeenCalledTimes(1);
      expect(benefitReadMock.mock.calls[0]).toEqual([TENANT_ID, MEMBER_UUID]);
    });

    it('reader returns empty array → benefitsAvailable TRUE with empty list', async () => {
      // An empty (but non-null) list is "available, nothing metered this
      // plan" — distinct from `null` (unavailable). The UI still falls
      // back to the neutral copy because `benefits.length === 0`, but the
      // use-case must NOT coerce an empty list into `benefitsAvailable=false`.
      const cycle = buildCycle();
      const { deps } = fakeDeps({ cycle, benefitConsumption: [] });
      const r = await loadRenewalSummary(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.benefits).toEqual([]);
        expect(r.value.benefitsAvailable).toBe(true);
      }
    });

    it('reader returns null → benefits empty + benefitsAvailable FALSE (neutral fallback)', async () => {
      const cycle = buildCycle();
      const { deps } = fakeDeps({ cycle, benefitConsumption: null });
      const r = await loadRenewalSummary(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.benefits).toEqual([]);
        expect(r.value.benefitsAvailable).toBe(false);
      }
    });

    it('reader THROWS → degrades gracefully to empty + FALSE (no reject, no 500)', async () => {
      // The graceful fallback is REQUIRED — a benefit-read failure must
      // never turn the renewal page into a 500. Mirrors the
      // isFirstTimeRenewer try/catch fail-safe in the same use-case.
      const cycle = buildCycle();
      const { deps } = fakeDeps({ cycle, benefitConsumption: 'throw' });
      const r = await loadRenewalSummary(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.benefits).toEqual([]);
        expect(r.value.benefitsAvailable).toBe(false);
      }
    });
  });
});
