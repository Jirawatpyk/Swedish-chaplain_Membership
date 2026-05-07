/**
 * F8 Phase 5 Wave B · T121 spec — `loadRenewalSummary`.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadRenewalSummary } from '@/modules/renewals/application/use-cases/load-renewal-summary';
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
}): {
  deps: RenewalsDeps;
  emitMock: ReturnType<typeof vi.fn>;
} {
  const findByIdMock = vi.fn(async () => args.cycle ?? null);
  const emitMock = vi.fn(args.emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    cyclesRepo: {
      findById: findByIdMock,
    },
    auditEmitter: {
      emit: emitMock,
      emitInTx: vi.fn(async () => {}),
    },
  } as unknown as RenewalsDeps;
  return { deps, emitMock };
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
  it('happy path — returns frozen price + benefits empty + first-time true', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({ cycle });
    const r = await loadRenewalSummary(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.frozenPlanPriceThb).toBe('50000.00');
      expect(r.value.frozenPlanTermMonths).toBe(12);
      expect(r.value.frozenPlanCurrency).toBe('THB');
      expect(r.value.status).toBe('awaiting_payment');
      expect(r.value.benefits).toEqual([]);
      expect(r.value.benefitsAvailable).toBe(false);
      expect(r.value.isFirstTimeRenewer).toBe(true);
    }
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
});
