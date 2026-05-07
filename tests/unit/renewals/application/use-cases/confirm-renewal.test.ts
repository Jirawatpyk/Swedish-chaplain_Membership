/**
 * F8 Phase 5 Wave B · T122 spec — `confirmRenewal`.
 *
 * 100% branch coverage required (Constitution Principle II — security-
 * critical mutating path collecting member payment intent).
 */
import { describe, expect, it, vi } from 'vitest';
import { confirmRenewal } from '@/modules/renewals/application/use-cases/confirm-renewal';
import type { ConfirmRenewalDeps } from '@/modules/renewals/application/use-cases/confirm-renewal';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalResult,
} from '@/modules/renewals/application/ports/f4-invoicing-bridge';
import type {
  PlanLookupForRenewalPort,
  PlanLookupForRenewalResult,
} from '@/modules/renewals/application/ports/plan-lookup-for-renewal';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a122';
const CYCLE_UUID = '00000000-0000-0000-0000-0000000c1220';
const NEW_PLAN_ID = 'plan-premium-2026';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function buildCycle(overrides: Partial<RenewalCycle> = {}): RenewalCycle {
  return buildCycleShared({
    tenantId: TENANT_ID,
    cycleId: asCycleId(CYCLE_UUID),
    memberId: MEMBER_UUID,
    status: 'awaiting_payment',
    planIdAtCycleStart: 'plan-regular-2026',
    tierAtCycleStart: 'regular',
    frozenPlanPriceThb: '50000.00',
    frozenPlanTermMonths: 12,
    frozenPlanCurrency: 'THB',
    ...overrides,
  });
}

function fakeDeps(args: {
  cycle?: RenewalCycle | null;
  planLookup?: PlanLookupForRenewalResult;
  invoiceResult?: IssueInvoiceForRenewalResult;
  updateFrozenPlanImpl?: () => Promise<RenewalCycle>;
  linkInvoiceImpl?: () => Promise<RenewalCycle>;
  emitInTxImpl?: () => Promise<void>;
}): {
  deps: ConfirmRenewalDeps;
  planLookupMock: ReturnType<typeof vi.fn>;
  invoiceBridgeMock: ReturnType<typeof vi.fn>;
  updateFrozenPlanMock: ReturnType<typeof vi.fn>;
  linkInvoiceMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const findByIdInTxMock = vi.fn(async () => args.cycle ?? null);
  const updateFrozenPlanMock = vi.fn(
    args.updateFrozenPlanImpl ??
      (async () => ({
        ...args.cycle!,
        planIdAtCycleStart: NEW_PLAN_ID,
        tierAtCycleStart: 'premium' as const,
        frozenPlanPriceThb: '180000.00',
      } as unknown as RenewalCycle)),
  );
  const linkInvoiceMock = vi.fn(
    args.linkInvoiceImpl ?? (async () => args.cycle ?? buildCycle()),
  );
  const planLookupMock = vi.fn(
    async (): Promise<PlanLookupForRenewalResult> =>
      args.planLookup ?? {
        status: 'found',
        plan: {
          tierBucket: 'premium',
          priceTHB: '180000.00',
          termMonths: 12,
          currency: 'THB',
        },
      },
  );
  const invoiceBridgeMock = vi.fn(
    async (): Promise<IssueInvoiceForRenewalResult> =>
      args.invoiceResult ?? {
        status: 'issued',
        invoiceId: 'inv-1',
        invoiceNumber: 'INV-2026-0001',
        totalSatang: 5_000_000n,
      },
  );
  const emitInTxMock = vi.fn(args.emitInTxImpl ?? (async () => {}));
  const planLookup: PlanLookupForRenewalPort = {
    loadPlanFrozenFields: planLookupMock as never,
  };
  const invoiceBridge: F4InvoicingForRenewalBridge = {
    issueInvoiceForRenewal: invoiceBridgeMock as never,
  };
  const deps: ConfirmRenewalDeps = {
    tenant: { slug: TENANT_ID } as ConfirmRenewalDeps['tenant'],
    cyclesRepo: {
      findByIdInTx: findByIdInTxMock,
      updateFrozenPlan: updateFrozenPlanMock,
      linkInvoice: linkInvoiceMock,
    } as unknown as ConfirmRenewalDeps['cyclesRepo'],
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    } as unknown as ConfirmRenewalDeps['auditEmitter'],
    f4InvoicingBridge: invoiceBridge,
    planLookupForRenewal: planLookup,
  };
  return {
    deps,
    planLookupMock,
    invoiceBridgeMock,
    updateFrozenPlanMock,
    linkInvoiceMock,
    emitInTxMock,
  };
}

const baseInput = {
  tenantId: TENANT_ID,
  cycleId: CYCLE_UUID,
  memberId: MEMBER_UUID,
  planYear: 2026,
  actorUserId: 'user-1',
  actorRole: 'member' as const,
  correlationId: 'corr-1',
};

describe('confirmRenewal (T122) — happy paths', () => {
  it('happy path no plan-change — issues invoice + links + emits invoice_created', async () => {
    const cycle = buildCycle();
    const {
      deps,
      invoiceBridgeMock,
      planLookupMock,
      linkInvoiceMock,
      emitInTxMock,
    } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.invoiceId).toBe('inv-1');
      expect(r.value.payUrl).toBe('/portal/invoices/inv-1/pay');
      expect(r.value.planChanged).toBe(false);
    }
    expect(planLookupMock).not.toHaveBeenCalled();
    expect(invoiceBridgeMock).toHaveBeenCalledOnce();
    expect(linkInvoiceMock).toHaveBeenCalledOnce();
    // Two emits: cross_member_probe is skipped (matches), so only the
    // invoice_created emit fires from the link tx (the planChange emits
    // would also be in the state tx if a plan change occurred).
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_invoice_created',
    });
  });

  it('happy path plan-change — updates frozen plan + emits 3 audits', async () => {
    const cycle = buildCycle();
    const { deps, planLookupMock, updateFrozenPlanMock, emitInTxMock } =
      fakeDeps({ cycle });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.planChanged).toBe(true);
    expect(planLookupMock).toHaveBeenCalledOnce();
    expect(updateFrozenPlanMock).toHaveBeenCalledOnce();
    expect(updateFrozenPlanMock.mock.calls[0]?.[3]).toMatchObject({
      planIdAtCycleStart: NEW_PLAN_ID,
      frozenPlanPriceThb: '180000.00',
    });
    // Three emits: with_plan_change + cycle_price_frozen + invoice_created
    const emittedTypes = emitInTxMock.mock.calls.map(
      (c) => (c?.[1] as { type: string })?.type,
    );
    expect(emittedTypes).toContain('renewal_with_plan_change');
    expect(emittedTypes).toContain('renewal_cycle_price_frozen');
    expect(emittedTypes).toContain('renewal_invoice_created');
  });

  it('newPlanId equal to current plan — no plan-change branch fires', async () => {
    const cycle = buildCycle();
    const { deps, planLookupMock, updateFrozenPlanMock } = fakeDeps({
      cycle,
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: cycle.planIdAtCycleStart, // same as current
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.planChanged).toBe(false);
    expect(planLookupMock).not.toHaveBeenCalled();
    expect(updateFrozenPlanMock).not.toHaveBeenCalled();
  });
});

describe('confirmRenewal (T122) — state validation', () => {
  it('cycle_not_found when cycle is null', async () => {
    const { deps } = fakeDeps({ cycle: null });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_found');
  });

  it('cross_member_probe — emits audit + returns error', async () => {
    const cycle = buildCycle({ memberId: '00000000-0000-0000-0000-000000000999' });
    const { deps, emitInTxMock } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cross_member_probe') {
      expect(r.error.attemptedMemberId).toBe('00000000-0000-0000-0000-000000000999');
    }
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_cross_member_probe',
    });
  });

  it('cycle_not_payable — status mismatch', async () => {
    const cycle = buildCycle({ status: 'completed' });
    const { deps, invoiceBridgeMock } = fakeDeps({ cycle });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'cycle_not_payable') {
      expect(r.error.currentStatus).toBe('completed');
    }
    expect(invoiceBridgeMock).not.toHaveBeenCalled();
  });
});

describe('confirmRenewal (T122) — plan-change error paths', () => {
  it('plan_not_found when plan-lookup returns not_found', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      planLookup: { status: 'not_found' },
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('plan_not_found');
  });

  it('plan_inactive when plan-lookup returns plan_inactive', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      planLookup: { status: 'plan_inactive' },
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('plan_inactive');
  });

  it('TransitionConflict during plan-change → cycle_not_payable', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      updateFrozenPlanImpl: async () => {
        throw new CycleTransitionConflictError(
          CYCLE_UUID,
          'awaiting_payment',
          'cancelled',
        );
      },
    });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      newPlanId: NEW_PLAN_ID,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('cycle_not_payable');
  });
});

describe('confirmRenewal (T122) — F4 invoice creation failures', () => {
  it('create_failed → invoice_creation_failed stage=create', async () => {
    const cycle = buildCycle();
    const { deps, linkInvoiceMock } = fakeDeps({
      cycle,
      invoiceResult: {
        status: 'create_failed',
        errorCode: 'plan_not_found',
        detail: 'F4 plan lookup empty',
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invoice_creation_failed') {
      expect(r.error.stage).toBe('create');
      expect(r.error.errorCode).toBe('plan_not_found');
    }
    expect(linkInvoiceMock).not.toHaveBeenCalled();
  });

  it('issue_failed → invoice_creation_failed stage=issue', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      invoiceResult: {
        status: 'issue_failed',
        errorCode: 'sequence_allocator_locked',
        detail: 'F4 §87 advisory lock timeout',
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.kind === 'invoice_creation_failed') {
      expect(r.error.stage).toBe('issue');
    }
  });
});

describe('confirmRenewal (T122) — link / audit failure paths', () => {
  it('CycleNotFoundError on linkInvoice — returns server_error (orphan F4 invoice)', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      linkInvoiceImpl: async () => {
        throw new CycleNotFoundError(CYCLE_UUID);
      },
    });
    const r = await confirmRenewal(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });

  it('Principle VIII — audit emit failure throws to roll back linkInvoice', async () => {
    const cycle = buildCycle();
    const { deps } = fakeDeps({
      cycle,
      emitInTxImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    await expect(confirmRenewal(deps, baseInput)).rejects.toThrow(
      /audit_log: insert failed/,
    );
  });
});

describe('confirmRenewal (T122) — input validation', () => {
  it('invalid_input on malformed cycleId', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      cycleId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('invalid_input on out-of-range planYear', async () => {
    const { deps } = fakeDeps({ cycle: buildCycle() });
    const r = await confirmRenewal(deps, {
      ...baseInput,
      planYear: 1999,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
