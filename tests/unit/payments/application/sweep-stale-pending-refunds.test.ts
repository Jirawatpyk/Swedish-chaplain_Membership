/**
 * A.14 — sweepStalePendingRefunds Stripe-aware finalisation (unit).
 *
 * Rewritten from the T130a blind-fail suite: the sweep now retrieves each
 * stale-`pending` refund's REAL status from Stripe and finalises it
 * (`succeeded` → F4 CN + flip · `failed|canceled` → inline flip · `pending`
 * / null-id → skip + escalate) instead of unconditionally marking it
 * `failed`. `finalizeSucceededRefund` + `paymentsMetrics` are mocked so the
 * sweep's own branching + bounds are asserted in isolation; the live-DB
 * finalise is covered by `tests/integration/payments/sweep-stripe-aware.test.ts`.
 *
 * Coverage policy: 100% branch (security-critical recovery path).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fc from 'fast-check';

// The shared finaliser is mocked so we control ok/err/siblingWon without
// wiring its internal repo graph. vi.mock is hoisted; the sweep's relative
// `./_finalize-succeeded-refund` import resolves to the same module id.
vi.mock(
  '@/modules/payments/application/use-cases/_finalize-succeeded-refund',
  () => ({ finalizeSucceededRefund: vi.fn() }),
);
// Metrics are mocked (importActual + override) so we can assert the sweep's
// counters fire while leaving every other real metric intact.
vi.mock('@/lib/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...actual,
    paymentsMetrics: {
      ...actual.paymentsMetrics,
      refundSucceededCount: vi.fn(),
      refundFailedCount: vi.fn(),
      stalePendingRefundEscalated: vi.fn(),
      refundPendingAwaitingProcessor: vi.fn(),
    },
  };
});

import { sweepStalePendingRefunds } from '@/modules/payments';
import type {
  SweepStalePendingRefundsDeps,
  SweepStalePendingRefundsInput,
} from '@/modules/payments';
import { finalizeSucceededRefund } from '@/modules/payments/application/use-cases/_finalize-succeeded-refund';
import { paymentsMetrics } from '@/lib/metrics';
import { ok, err } from '@/lib/result';
import { asPaymentId } from '@/modules/payments/domain/payment';
import { asRefundId, type Refund } from '@/modules/payments/domain/refund';
import { asSatang } from '@/lib/money';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '@/modules/payments/domain/system-actors';

const TENANT_ID = 'tnt-1';
const NOW_MS = Date.parse('2026-07-11T10:00:00.000Z');
const PAYMENT_ID = asPaymentId('pmt_01JABCDEFGHJKMNPQRSTVWXYZ');
const STRIPE_ACCOUNT = 'acct_test_sweep01';
const AMOUNT = asSatang(350_000n);
const HOUR_MS = 60 * 60 * 1000;

const mockFinalize = vi.mocked(finalizeSucceededRefund);

function asMock<T>(fn: T): ReturnType<typeof vi.fn> {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

type StaleRow = {
  id: string;
  paymentId: typeof PAYMENT_ID;
  invoiceId: string;
  amountSatang: typeof AMOUNT;
  initiatedAt: Date;
  correlationId: string;
  initiatorUserId: string;
  processorRefundId: string | null;
};

function makeStaleRow(
  overrides: {
    id?: string;
    ageHours?: number;
    processorRefundId?: string | null;
  } = {},
): StaleRow {
  const ageHours = overrides.ageHours ?? 30;
  return {
    id: overrides.id ?? 'rfnd_01STALE',
    paymentId: PAYMENT_ID,
    invoiceId: 'inv-1',
    amountSatang: AMOUNT,
    initiatedAt: new Date(NOW_MS - ageHours * HOUR_MS),
    correlationId: 'corr-stale',
    initiatorUserId: 'user-admin-1',
    processorRefundId:
      overrides.processorRefundId !== undefined
        ? overrides.processorRefundId
        : 're_stale1',
  };
}

function makeLockedRefund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: asRefundId('rfnd_01STALE'),
    tenantId: TENANT_ID,
    paymentId: PAYMENT_ID,
    invoiceId: 'inv-1',
    amountSatang: AMOUNT,
    reason: 'test refund',
    status: 'pending',
    processorRefundId: 're_stale1',
    failureReasonCode: null,
    creditNoteId: null,
    creditNoteWaivedAt: null,
    creditNoteWaiverReason: null,
    initiatedAt: new Date(NOW_MS - 30 * HOUR_MS),
    completedAt: null,
    initiatorUserId: 'user-admin-1',
    correlationId: 'corr-stale',
    ...overrides,
  };
}

function retrievedRefund(status: string) {
  return ok({
    id: 're_stale1',
    status,
    chargeId: 'ch_1',
    paymentIntentId: 'pi_1',
    amountSatang: AMOUNT,
  });
}

function makeDeps(): SweepStalePendingRefundsDeps {
  const tx = Symbol('tx');
  return {
    paymentsRepo: {
      withTx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as SweepStalePendingRefundsDeps['paymentsRepo'],
    refundsRepo: {
      listPendingOlderThan: vi.fn(async () => [makeStaleRow()]),
      lockForUpdateByProcessorRefundId: vi.fn(async () => makeLockedRefund()),
      // return value is ignored by the sweep's failed-branch flip
      updateStatus: vi.fn(async () => makeLockedRefund({ status: 'failed' })),
    } as unknown as SweepStalePendingRefundsDeps['refundsRepo'],
    tenantSettingsRepo: {
      getByTenantId: vi.fn(async () => ({
        tenantId: TENANT_ID,
        processor: 'stripe' as const,
        processorEnvironment: 'test' as const,
        processorAccountId: STRIPE_ACCOUNT,
        processorPublishableKey: 'pk_test_sweep01',
        enabledMethods: ['card'] as const,
        onlinePaymentEnabled: true,
        autoEmailOnPayment: true,
        promptpayQrExpirySeconds: 900,
        allowAnonymousPaylink: false,
      })),
      findByProcessorAccountId: vi.fn(async () => null),
    } as unknown as SweepStalePendingRefundsDeps['tenantSettingsRepo'],
    processorGateway: {
      retrieveRefund: vi.fn(async () => retrievedRefund('succeeded')),
    } as unknown as SweepStalePendingRefundsDeps['processorGateway'],
    invoicingBridge: {
      issueCreditNoteFromRefund: vi.fn(async () =>
        ok({ creditNoteId: 'cn-1', creditNoteNumber: 'TC-1' }),
      ),
      // 8B note — this suite MOCKS `finalizeSucceededRefund` (top of file), so
      // the finaliser's new Phase-B re-check (`getInvoiceCreditedTotal`) never
      // runs from here; no stub is needed. The real conversion is proven by the
      // finaliser's own callers: issue-refund unit + the concurrent-void
      // live-Neon integration test.
    } as unknown as SweepStalePendingRefundsDeps['invoicingBridge'],
    audit: { emit: vi.fn(async () => undefined) },
    clock: { nowIso: () => new Date(NOW_MS).toISOString(), nowMs: () => NOW_MS },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

const baseInput: SweepStalePendingRefundsInput = {
  tenantId: TENANT_ID,
  requestId: 'req-sweep-1',
};

describe('sweepStalePendingRefunds — Stripe-aware (A.14)', () => {
  beforeEach(() => {
    mockFinalize.mockResolvedValue(
      ok({
        // Track B — the finaliser result is discriminated on WHAT documented
        // the refund. The sweep only ever settles credit-noted refunds through
        // this stub; the waived arm carries no `invoiceStatus` at all.
        documentation: 'credit_note' as const,
        creditNoteId: 'cn-1',
        creditNoteNumber: 'TC-1',
        paymentNextStatus: 'refunded',
        invoiceStatus: 'credited',
        siblingWon: false,
      }),
    );
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- succeeded → finalise ------------------------------------------------
  it('retrieve succeeded → finalizeSucceededRefund(sweep_recovery, webhook-mode) → swept', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('succeeded'),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(1);
      expect(r.value.skippedCount).toBe(0);
      expect(r.value.escalatedCount).toBe(0);
    }

    // retrieve OUTSIDE the lock, scoped to the tenant's Stripe account.
    expect(asMock(deps.processorGateway.retrieveRefund)).toHaveBeenCalledWith(
      're_stale1',
      STRIPE_ACCOUNT,
    );
    // refund row locked FOR UPDATE FIRST (A.11 invariant).
    expect(
      asMock(deps.refundsRepo.lockForUpdateByProcessorRefundId),
    ).toHaveBeenCalledWith(expect.anything(), TENANT_ID, 're_stale1');
    // retrieve happened BEFORE finalise (retrieve outside lock).
    expect(
      asMock(deps.processorGateway.retrieveRefund).mock.invocationCallOrder[0],
    ).toBeLessThan(mockFinalize.mock.invocationCallOrder[0]!);

    const finalizeArgs = mockFinalize.mock.calls[0]?.[2];
    expect(finalizeArgs).toMatchObject({
      path: 'sweep_recovery',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      processorRefundId: 're_stale1',
      refundId: 'rfnd_01STALE',
    });
    // WEBHOOK mode — payment next status derived by the finaliser, not passed.
    expect(finalizeArgs).not.toHaveProperty('paymentNextStatus');
    expect(asMock(paymentsMetrics.refundSucceededCount)).toHaveBeenCalledWith(
      TENANT_ID,
    );
    // succeeded path issues no `failed` flip.
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  it('succeeded but siblingWon (concurrent writer finalised) → skip, no double metric', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('succeeded'),
    );
    mockFinalize.mockResolvedValueOnce(
      ok({
        // Track B — the finaliser result is discriminated on WHAT documented
        // the refund. The sweep only ever settles credit-noted refunds through
        // this stub; the waived arm carries no `invoiceStatus` at all.
        documentation: 'credit_note' as const,
        creditNoteId: 'cn-1',
        creditNoteNumber: 'TC-1',
        paymentNextStatus: 'refunded',
        invoiceStatus: 'credited',
        siblingWon: true,
      }),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }
    expect(asMock(paymentsMetrics.refundSucceededCount)).not.toHaveBeenCalled();
  });

  it('succeeded but F4 CN bridge declines → tx rolls back, refund NOT marked failed, skipped', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('succeeded'),
    );
    mockFinalize.mockResolvedValueOnce(
      err({ code: 'invoice_not_creditable', detail: 'x' }),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }
    // Stripe DEFINITIVELY succeeded → never mark failed.
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    expect(asMock(deps.logger!.warn)).toHaveBeenCalledWith(
      'sweep_stale_pending_refunds.row_skipped',
      expect.objectContaining({ errKind: 'SweepFinalizeError' }),
    );
  });

  it('Round-2 (#35): succeeded + F4 CN bridge declines + aged past 3d → escalation signal (credit_note_bridge_declined)', async () => {
    // Money is refunded at Stripe but the CN bridge persistently declines
    // (FEATURE_F4_INVOICING off / invoice hard-deleted / durable F4 fault), so
    // the row retries forever with NO §86/4/§87 credit note. Pre-fix this class
    // NEVER escalated (unlike missing_processor_refund_id / stripe_pending), so
    // SRE never saw the unrecoverable money-refunded-but-no-CN condition.
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_cn_stuck', ageHours: 120 }), // 5 days
    ]);
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('succeeded'),
    );
    mockFinalize.mockResolvedValueOnce(
      err({ code: 'invoice_not_creditable', detail: 'x' }),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.escalatedCount).toBe(1);
    }
    expect(
      asMock(paymentsMetrics.stalePendingRefundEscalated),
    ).toHaveBeenCalledWith(TENANT_ID, 'credit_note_bridge_declined');
    expect(asMock(deps.logger!.warn)).toHaveBeenCalledWith(
      'sweep_stale_pending_refunds.escalation',
      expect.objectContaining({ reason: 'credit_note_bridge_declined' }),
    );
    // Stripe DEFINITIVELY succeeded → never mark failed.
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  it('Round-2 (#35): succeeded + CN declines but YOUNG (<3d) → skip, NO escalation (transient decline never pages)', async () => {
    const deps = makeDeps(); // default row age 30h (< 3d threshold)
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('succeeded'),
    );
    mockFinalize.mockResolvedValueOnce(
      err({ code: 'invoice_not_creditable', detail: 'x' }),
    );
    const r = await sweepStalePendingRefunds(deps, baseInput);
    if (r.ok) {
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.escalatedCount).toBe(0);
    }
    expect(
      asMock(paymentsMetrics.stalePendingRefundEscalated),
    ).not.toHaveBeenCalled();
  });

  // --- failed / canceled → inline flip -------------------------------------
  it('retrieve failed → inline flip refund→failed + refund_failed audit (no CN) → swept', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('failed'),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sweptCount).toBe(1);

    expect(mockFinalize).not.toHaveBeenCalled();
    const updArg = asMock(deps.refundsRepo.updateStatus).mock.calls[0]?.[1];
    expect(updArg).toMatchObject({
      nextStatus: 'failed',
      failureReasonCode: 'stripe_refund_failed',
      processorRefundId: 're_stale1',
    });
    // We hold the FOR UPDATE lock + re-checked pending → no optimistic guard.
    expect(updArg.expectedCurrentStatus).toBeUndefined();

    const auditArg = asMock(deps.audit.emit).mock.calls[0]?.[1];
    expect(auditArg.eventType).toBe('refund_failed');
    expect(auditArg.actorUserId).toBe(SYSTEM_ACTOR_STRIPE_WEBHOOK);
    expect(auditArg.payload.failure_reason_code).toBe('stripe_refund_failed');
    expect(auditArg.payload.processor_refund_id).toBe('re_stale1');
    expect(asMock(paymentsMetrics.refundFailedCount)).toHaveBeenCalledWith(
      TENANT_ID,
      'stripe_refund_failed',
    );
  });

  it('retrieve canceled → inline flip with stripe_refund_canceled → swept', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('canceled'),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    if (r.ok) expect(r.value.sweptCount).toBe(1);
    const updArg = asMock(deps.refundsRepo.updateStatus).mock.calls[0]?.[1];
    expect(updArg.failureReasonCode).toBe('stripe_refund_canceled');
  });

  // --- pending → skip (NEVER failed) ---------------------------------------
  it('retrieve pending → skip; NEVER marked failed (A.8 null-coercion guard)', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('pending'),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.escalatedCount).toBe(0); // 30h < 3d threshold
    }
    // No lock, no flip, no finalise, no audit → zero state change.
    expect(
      asMock(deps.refundsRepo.lockForUpdateByProcessorRefundId),
    ).not.toHaveBeenCalled();
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(asMock(deps.audit.emit)).not.toHaveBeenCalled();
  });

  it('retrieve requires_action → skip (non-terminal, never failed)', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('requires_action'),
    );
    const r = await sweepStalePendingRefunds(deps, baseInput);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  it('retrieve pending + aged past 3d → skip + escalation signal (no state change)', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_old', ageHours: 120 }), // 5 days
    ]);
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('pending'),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    if (r.ok) {
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.escalatedCount).toBe(1);
    }
    expect(
      asMock(paymentsMetrics.stalePendingRefundEscalated),
    ).toHaveBeenCalledWith(TENANT_ID, 'stripe_pending');
    // A.16 (H-e) — a Stripe-still-pending stale refund is awaiting the async
    // charge.refund.updated webhook → the monitoring signal fires (independent
    // of the aged-escalation signal above).
    expect(
      asMock(paymentsMetrics.refundPendingAwaitingProcessor),
    ).toHaveBeenCalledWith(TENANT_ID);
    expect(asMock(deps.logger!.warn)).toHaveBeenCalledWith(
      'sweep_stale_pending_refunds.escalation',
      expect.objectContaining({ reason: 'stripe_pending' }),
    );
    // Still no state change.
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
  });

  // --- null processor_refund_id → skip + escalate (NEVER blind-fail) -------
  it('null processor_refund_id + aged → skip + escalate; retrieve NOT called; never failed', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_nullid', processorRefundId: null, ageHours: 100 }),
    ]);

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.escalatedCount).toBe(1);
    }
    // Cannot reconcile → never retrieve, never flip.
    expect(asMock(deps.processorGateway.retrieveRefund)).not.toHaveBeenCalled();
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    expect(asMock(deps.audit.emit)).not.toHaveBeenCalled();
    expect(
      asMock(paymentsMetrics.stalePendingRefundEscalated),
    ).toHaveBeenCalledWith(TENANT_ID, 'missing_processor_refund_id');
    expect(asMock(deps.logger!.warn)).toHaveBeenCalledWith(
      'sweep_stale_pending_refunds.escalation',
      expect.objectContaining({ reason: 'missing_processor_refund_id' }),
    );
  });

  it('null processor_refund_id + young → skip, NO escalation', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_nullid_new', processorRefundId: null, ageHours: 10 }),
    ]);

    const r = await sweepStalePendingRefunds(deps, baseInput);
    if (r.ok) {
      expect(r.value.skippedCount).toBe(1);
      expect(r.value.escalatedCount).toBe(0);
    }
    expect(
      asMock(paymentsMetrics.stalePendingRefundEscalated),
    ).not.toHaveBeenCalled();
  });

  // --- retrieve error / timeout → skip + count -----------------------------
  it('retrieve error → skip + count, no state change; PCI kind-only log', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      err({ kind: 'retryable', reason: 'stripe down secret-detail' }),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }
    expect(
      asMock(deps.refundsRepo.lockForUpdateByProcessorRefundId),
    ).not.toHaveBeenCalled();
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    const warnCall = asMock(deps.logger!.warn).mock.calls.find(
      (c) => c[0] === 'sweep_stale_pending_refunds.retrieve_failed',
    );
    expect(warnCall?.[1]).toMatchObject({ errKind: 'retryable' });
    // PCI: the raw Stripe `reason` must never be logged.
    expect(JSON.stringify(warnCall?.[1])).not.toContain('secret-detail');
  });

  it('per-retrieve timeout → skip + count (external-call bound)', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      asMock(deps.processorGateway.retrieveRefund).mockReturnValueOnce(
        new Promise(() => {
          /* never resolves — simulates a hung Stripe call */
        }),
      );

      const p = sweepStalePendingRefunds(deps, baseInput);
      await vi.advanceTimersByTimeAsync(8_000 + 50);
      const r = await p;

      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.sweptCount).toBe(0);
        expect(r.value.skippedCount).toBe(1);
      }
      expect(
        asMock(deps.refundsRepo.lockForUpdateByProcessorRefundId),
      ).not.toHaveBeenCalled();
      expect(asMock(deps.logger!.warn)).toHaveBeenCalledWith(
        'sweep_stale_pending_refunds.retrieve_timeout',
        expect.objectContaining({ refundId: 'rfnd_01STALE' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // --- RR-1 lost race under the lock ---------------------------------------
  it('RR-1: row concurrently finalised (lock re-check != pending) → skip, NO audit', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('succeeded'),
    );
    // A concurrent webhook/Phase-B finalised it between list-read and lock.
    asMock(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      makeLockedRefund({
        status: 'succeeded',
        creditNoteId: 'cn-existing',
        creditNoteWaivedAt: null,
        creditNoteWaiverReason: null,
        completedAt: new Date(NOW_MS),
      }),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }
    // No finalise, no flip, no audit → no false stale/refund audit on the race.
    expect(mockFinalize).not.toHaveBeenCalled();
    expect(asMock(deps.refundsRepo.updateStatus)).not.toHaveBeenCalled();
    expect(asMock(deps.audit.emit)).not.toHaveBeenCalled();
  });

  it('lock returns null (row vanished) → skip', async () => {
    const deps = makeDeps();
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValueOnce(
      retrievedRefund('succeeded'),
    );
    asMock(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockResolvedValueOnce(
      null,
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(0);
      expect(r.value.skippedCount).toBe(1);
    }
    expect(mockFinalize).not.toHaveBeenCalled();
  });

  // --- mixed batch + per-row isolation -------------------------------------
  it('mixed batch: succeeded + failed + pending → swept=2, skipped=1', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_ok', processorRefundId: 're_ok' }),
      makeStaleRow({ id: 'rfnd_bad', processorRefundId: 're_bad' }),
      makeStaleRow({ id: 'rfnd_wait', processorRefundId: 're_wait' }),
    ]);
    asMock(deps.processorGateway.retrieveRefund)
      .mockResolvedValueOnce(retrievedRefund('succeeded'))
      .mockResolvedValueOnce(retrievedRefund('failed'))
      .mockResolvedValueOnce(retrievedRefund('pending'));
    asMock(deps.refundsRepo.lockForUpdateByProcessorRefundId).mockImplementation(
      async (_tx: unknown, _tid: string, re: string) =>
        makeLockedRefund({ processorRefundId: re }),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(2);
      expect(r.value.skippedCount).toBe(1);
    }
    // Per-row tx isolation: 1 read tx + 2 finalise/flip write tx.
    expect(
      asMock(deps.paymentsRepo.withTx).mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('per-row DB fault → that row skipped, others continue', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_a', processorRefundId: 're_a' }),
      makeStaleRow({ id: 'rfnd_b', processorRefundId: 're_b' }),
    ]);
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValue(
      retrievedRefund('failed'),
    );
    // Row A's flip throws; row B succeeds.
    asMock(deps.refundsRepo.updateStatus)
      .mockRejectedValueOnce(new Error('row a db fault'))
      .mockResolvedValueOnce(makeLockedRefund({ status: 'failed' }));

    const r = await sweepStalePendingRefunds(deps, baseInput);
    if (r.ok) {
      expect(r.value.sweptCount).toBe(1);
      expect(r.value.skippedCount).toBe(1);
    }
  });

  // --- M-i bounds ----------------------------------------------------------
  it('row cap: >50 stale rows → only 50 processed, truncation logged', async () => {
    const deps = makeDeps();
    const rows = Array.from({ length: 55 }, (_, i) =>
      makeStaleRow({ id: `rfnd_${i}`, processorRefundId: `re_${i}` }),
    );
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce(rows);
    // pending → skip keeps the test fast (no tx) but still exercises the cap.
    asMock(deps.processorGateway.retrieveRefund).mockResolvedValue(
      retrievedRefund('pending'),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.skippedCount).toBe(50);
    expect(asMock(deps.processorGateway.retrieveRefund)).toHaveBeenCalledTimes(
      50,
    );
    expect(asMock(deps.logger!.warn)).toHaveBeenCalledWith(
      'sweep_stale_pending_refunds.row_cap_truncated',
      expect.objectContaining({ total: 55, cap: 50, deferred: 5 }),
    );
  });

  it('total wall-clock budget guard → stops starting new rows, deferral logged', async () => {
    const deps = makeDeps();
    let elapsed = 0;
    // Clock advances only when a retrieve runs, so row A processes then the
    // cumulative budget is blown before row B's top-of-loop check.
    (deps.clock as { nowMs: () => number }).nowMs = () => NOW_MS + elapsed;
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([
      makeStaleRow({ id: 'rfnd_a', processorRefundId: 're_a' }),
      makeStaleRow({ id: 'rfnd_b', processorRefundId: 're_b' }),
    ]);
    asMock(deps.processorGateway.retrieveRefund).mockImplementation(async () => {
      elapsed += 50_000; // exceed the 35s budget after the first retrieve
      return retrievedRefund('succeeded');
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sweptCount).toBe(1); // only row A
    // Row B deferred BEFORE its retrieve → exactly one external call.
    expect(asMock(deps.processorGateway.retrieveRefund)).toHaveBeenCalledTimes(
      1,
    );
    expect(asMock(deps.logger!.warn)).toHaveBeenCalledWith(
      'sweep_stale_pending_refunds.budget_deferred',
      expect.objectContaining({ processed: 1, deferred: 1 }),
    );
  });

  // --- guards + read failures ----------------------------------------------
  it('tenant settings missing → sweep_failed; list never read', async () => {
    const deps = makeDeps();
    asMock(deps.tenantSettingsRepo.getByTenantId).mockResolvedValueOnce(null);

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.cause).toBe('tenant_settings_missing');
    expect(asMock(deps.refundsRepo.listPendingOlderThan)).not.toHaveBeenCalled();
  });

  it('empty result → swept=0, no retrieve, no audit', async () => {
    const deps = makeDeps();
    asMock(deps.refundsRepo.listPendingOlderThan).mockResolvedValueOnce([]);

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sweptCount).toBe(0);
    expect(asMock(deps.processorGateway.retrieveRefund)).not.toHaveBeenCalled();
    expect(asMock(deps.audit.emit)).not.toHaveBeenCalled();
  });

  it('invalid olderThanHours (≤ 0) → sweep_failed; settings never read', async () => {
    const deps = makeDeps();
    const r = await sweepStalePendingRefunds(deps, {
      ...baseInput,
      olderThanHours: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('sweep_failed');
      expect(r.error.cause).toMatch(/olderThanHours/);
    }
    expect(asMock(deps.tenantSettingsRepo.getByTenantId)).not.toHaveBeenCalled();
  });

  it('property: every olderThanHours ≤ 0 → sweep_failed (no settings read)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ max: 0 }), async (hours) => {
        const deps = makeDeps();
        const r = await sweepStalePendingRefunds(deps, {
          ...baseInput,
          olderThanHours: hours,
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('sweep_failed');
        expect(
          asMock(deps.tenantSettingsRepo.getByTenantId),
        ).not.toHaveBeenCalled();
      }),
      { numRuns: 25 },
    );
  });

  it('list-read tx throw → sweep_failed with constructor.name only (R3 H3-3)', async () => {
    const deps = makeDeps();
    asMock(deps.paymentsRepo.withTx).mockImplementationOnce(async () => {
      throw new Error('connection lost');
    });

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('sweep_failed');
      expect(r.error.cause).toBe('Error');
    }
  });

  it('tenant-settings read throw → sweep_failed with constructor.name only', async () => {
    const deps = makeDeps();
    asMock(deps.tenantSettingsRepo.getByTenantId).mockRejectedValueOnce(
      new TypeError('cache miss'),
    );

    const r = await sweepStalePendingRefunds(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.cause).toBe('TypeError');
  });
});
