/**
 * Unit test for `finaliseF2PlanChangeForPaidInvoiceOnline` — the POST-commit
 * entry point the ONLINE F4 invoice-paid rails (F5 webhook `confirmPayment` +
 * the admin F4 manual-pay route) use to finalise the F2 scheduled-plan-change
 * AFTER the settlement tx commits (never in-callback — that self-deadlocks
 * against the member-row lock).
 *
 * Pins:
 *   - the re-resolve: cycle (+ member) is recovered from the invoice id via
 *     `cyclesRepo.findByInvoiceIdInTx`, then the finaliser runs under the
 *     ONLINE `'system:f8-on-paid-webhook'` actor (the coverage the deleted
 *     `f8-onPaid-f2-finalise.test.ts` used to provide via the `_internal`
 *     helper);
 *   - a non-renewal invoice (no linked cycle) is a clean no-op;
 *   - a re-resolve failure is logged (F2.PLAN_CHANGE.CYCLE_RESOLVE_FAILED) +
 *     swallowed (never re-thrown — the caller's payment is already durable).
 *
 * Pure Application — port interfaces only; `@/lib/db` runInTenant + logger
 * stubbed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { finaliseF2PlanChangeForPaidInvoiceOnline } from '@/modules/renewals/application/use-cases/finalise-f2-plan-change-on-paid';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const { loggerErrorMock, f2FinaliseBeforeF4CommitMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  f2FinaliseBeforeF4CommitMock: vi.fn(),
}));

// runInTenant just invokes the callback with a fake tx — the finaliser's
// re-resolve read is the only thing that uses it here.
const fakeTx = { execute: vi.fn() };
vi.mock('@/lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db')>();
  return {
    ...actual,
    runInTenant: vi.fn(
      async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) => fn(fakeTx),
    ),
  };
});

vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    renewalsMetrics: {
      ...actual.renewalsMetrics,
      f2FinaliseBeforeF4Commit: f2FinaliseBeforeF4CommitMock,
    },
  };
});

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  const { createMockLogger } = await import('../../../../helpers/mock-logger');
  return {
    ...actual,
    logger: createMockLogger({ error: loggerErrorMock }),
  };
});

const TENANT_ID = 'tenantA';
const CYCLE_ID = '00000000-0000-0000-0000-0000000000c4';
const INVOICE_ID = '11111111-1111-1111-1111-111111111111';
const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const LINKED_SUGGESTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const PENDING_ROW = {
  tenantId: TENANT_ID,
  scheduledChangeId: 'sched-1',
  memberId: MEMBER_ID,
  effectiveAtCycleId: CYCLE_ID,
  fromPlanId: 'regular',
  toPlanId: 'premium',
  scheduledByUserId: 'admin-1',
  reason: `tier_upgrade_accepted:${LINKED_SUGGESTION_ID}`,
  status: 'pending' as const,
  scheduledAt: '2026-05-01T00:00:00Z',
  appliedAt: null,
  supersededAt: null,
  cancelledAt: null,
};

interface FakeDepsResult {
  deps: RenewalsDeps;
  findByInvoiceIdInTxMock: ReturnType<typeof vi.fn>;
  findPendingMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  recordMock: ReturnType<typeof vi.fn>;
}

function fakeDeps(opts: {
  cycle?: { cycleId: string; memberId: string } | null | Error;
  pending?: typeof PENDING_ROW | null;
}): FakeDepsResult {
  const findByInvoiceIdInTxMock = vi.fn(async () => {
    const c = opts.cycle;
    if (c instanceof Error) throw c;
    return c === undefined ? { cycleId: CYCLE_ID, memberId: MEMBER_ID } : c;
  });
  const findPendingMock = vi.fn(async () =>
    opts.pending === undefined ? PENDING_ROW : opts.pending,
  );
  const transitionMock = vi.fn(async (_t, scheduledChangeId, status) => ({
    ...PENDING_ROW,
    scheduledChangeId,
    status,
    appliedAt: '2026-06-05T09:00:00Z',
  }));
  const findByIdMock = vi.fn(async () => ({ status: 'applied' as const }));
  const recordMock = vi.fn(async () => ({ ok: true as const, value: undefined }));

  const deps = {
    tenant: { slug: TENANT_ID },
    cyclesRepo: { findByInvoiceIdInTx: findByInvoiceIdInTxMock },
    scheduledPlanChangeRepo: {
      findPendingForCycle: findPendingMock,
      transitionStatus: transitionMock,
    },
    tierUpgradeRepo: { findById: findByIdMock },
    f2AuditEmitter: { record: recordMock },
  } as unknown as RenewalsDeps;

  return { deps, findByInvoiceIdInTxMock, findPendingMock, transitionMock, recordMock };
}

describe('finaliseF2PlanChangeForPaidInvoiceOnline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('re-resolves the cycle from the invoice id then finalises under the ONLINE webhook actor', async () => {
    const { deps, findByInvoiceIdInTxMock, findPendingMock, transitionMock, recordMock } =
      fakeDeps({});

    await finaliseF2PlanChangeForPaidInvoiceOnline(deps, {
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
    });

    // Re-resolve happened by invoice id, not a threaded cycle id.
    expect(findByInvoiceIdInTxMock).toHaveBeenCalledWith(
      fakeTx,
      TENANT_ID,
      INVOICE_ID,
    );
    // Finaliser ran for the re-resolved (member, cycle).
    expect(findPendingMock).toHaveBeenCalledWith(deps.tenant, MEMBER_ID, CYCLE_ID);
    expect(transitionMock).toHaveBeenCalledTimes(1);
    expect(transitionMock.mock.calls[0]![2]).toBe('applied');
    // Audit recorded under the ONLINE actor (`system:f8-on-paid-webhook`).
    expect(recordMock).toHaveBeenCalledTimes(1);
    const [ctx, event] = recordMock.mock.calls[0]!;
    expect((ctx as { actorUserId?: string }).actorUserId).toBe(
      'system:f8-on-paid-webhook',
    );
    expect((ctx as { requestId?: string }).requestId).toBe(
      `f8-onPaid:${INVOICE_ID}`,
    );
    expect((event as { event_type?: string }).event_type).toBe(
      'plan_change_applied',
    );
    expect(
      (event as { payload: { applied_at_invoice_id: string } }).payload
        .applied_at_invoice_id,
    ).toBe(INVOICE_ID);
    expect(f2FinaliseBeforeF4CommitMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('is a clean no-op when the invoice resolves no renewal cycle (non-renewal invoice)', async () => {
    const { deps, findByInvoiceIdInTxMock, findPendingMock, recordMock } = fakeDeps({
      cycle: null,
    });

    await finaliseF2PlanChangeForPaidInvoiceOnline(deps, {
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
    });

    expect(findByInvoiceIdInTxMock).toHaveBeenCalledTimes(1);
    // No cycle → the finaliser never runs.
    expect(findPendingMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).not.toHaveBeenCalled();
  });

  it('swallows (logs, never re-throws) when the cycle re-resolve read throws', async () => {
    const { deps, findPendingMock } = fakeDeps({
      cycle: new Error('neon read failed post-commit'),
    });

    await expect(
      finaliseF2PlanChangeForPaidInvoiceOnline(deps, {
        tenantId: TENANT_ID,
        invoiceId: INVOICE_ID,
      }),
    ).resolves.toBeUndefined();

    expect(findPendingMock).not.toHaveBeenCalled();
    const log = loggerErrorMock.mock.calls.find(
      (c) =>
        (c[0] as { errorId?: string } | undefined)?.errorId ===
        'F2.PLAN_CHANGE.CYCLE_RESOLVE_FAILED',
    );
    expect(log).toBeDefined();
  });
});
