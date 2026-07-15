/**
 * F8 Phase 5 wave K24 · T115a — `lapseCyclesOnGraceExpiry` spec.ts.
 *
 * Branch coverage on the decision-branch lapse cron:
 *   - Happy `grace_expired`: cycle past grace window with zero F5
 *     failed payment attempts → transitions awaiting_payment → lapsed
 *     with `closed_reason='grace_expired'` + emits `renewal_lapsed`.
 *   - Happy `payment_failed`: cycle past grace window with ≥1 F5
 *     failed attempt → transitions with `closed_reason='payment_failed'`.
 *   - Null linked invoice → defaults to `grace_expired` (no F5 query).
 *   - Race-loss skip: cycle moved out of awaiting_payment between list
 *     query and tx-bound re-read → counted in transitionRaceSkipped.
 *   - Per-cycle error isolation: F5 bridge throws → counted in errors,
 *     cron continues with next cycle.
 *   - Settings missing → `tenant_settings_not_found`.
 *   - Invalid input → `invalid_input` from parseInput helper.
 */
import { describe, expect, it, vi } from 'vitest';
import { lapseCyclesOnGraceExpiry } from '@/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry';
import type { LapseCyclesOnGraceExpiryDeps } from '@/modules/renewals/application/use-cases/lapse-cycles-on-grace-expiry';
import type { RenewalCycle } from '@/modules/renewals/domain/renewal-cycle';
import type { TenantRenewalSettings } from '@/modules/renewals/domain/tenant-renewal-settings';
import type { F5PaymentAttemptsBridge } from '@/modules/renewals/application/ports/f5-payment-attempts-bridge';
import type { InvoiceDueBridge } from '@/modules/renewals/application/ports/invoice-due-bridge';
import {
  CycleTransitionConflictError,
  CycleNotFoundError,
} from '@/modules/renewals/application/ports/renewal-cycle-repo';
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';
import { renewalsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';

const TENANT_ID = 'tenantA';
const NOW = new Date('2026-05-08T00:00:00Z');
const INVOICE_UUID = '00000000-0000-0000-0000-0000000bbbb1';

vi.mock('@/lib/db', () => ({
  // 2026-05-17 polish — stub `db` to fix collection error.
  db: {},
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function expiredCycle(opts: {
  cycleSuffix?: string;
  daysPastGrace?: number;
  linkedInvoiceId?: string | null;
}): RenewalCycle {
  const cycleSuffix = opts.cycleSuffix ?? 'c001';
  // grace_period_days = 14 (default), so daysPastGrace=1 means
  // expires_at = now - 14 - 1 = 15 days ago.
  const daysPast = (opts.daysPastGrace ?? 1) + 14;
  const expiresAt = new Date(
    NOW.getTime() - daysPast * 86_400_000,
  ).toISOString();
  return buildCycleShared({
    cycleId: `00000000-0000-0000-0000-00000000${cycleSuffix}` as never,
    status: 'awaiting_payment',
    expiresAt,
    linkedInvoiceId:
      opts.linkedInvoiceId === undefined ? INVOICE_UUID : opts.linkedInvoiceId,
  });
}

function fakeDeps(args: {
  cycles: RenewalCycle[];
  failedAttemptsByInvoice?: Map<string, number>;
  countImpl?: (input: { invoiceId: string }) => Promise<number>;
  reReadCycle?: (cycle: RenewalCycle) => RenewalCycle | null;
  settings?: TenantRenewalSettings | null;
  emitInTxImpl?: () => Promise<void>;
  emitImpl?: () => Promise<void>;
  transitionImpl?: () => Promise<RenewalCycle>;
  /** 065 §5.2 — `InvoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate`
   * stub. Defaults to `null` (member has NO unpaid membership invoice → the
   * use-case falls back to the `expires_at + grace` backstop), so every
   * pre-existing test keeps its original grace_expired/payment_failed
   * behaviour — their cycles are seeded well past grace — unless it opts in
   * by returning a `due_date` string. */
  invoiceDueImpl?: (input: {
    tenantId: string;
    memberId: string;
  }) => Promise<string | null>;
}): {
  deps: LapseCyclesOnGraceExpiryDeps;
  emitInTxMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
  countMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
  invoiceDueMock: ReturnType<typeof vi.fn>;
} {
  const listMock = vi.fn(async () => ({
    items: args.cycles,
    nextCursor: null,
  }));
  const findByIdInTxMock = vi.fn(
    async (_tx: unknown, _t: string, cid: string) => {
      const found = args.cycles.find((c) => c.cycleId === cid);
      return args.reReadCycle && found
        ? args.reReadCycle(found)
        : found ?? null;
    },
  );
  const transitionMock = vi.fn(
    args.transitionImpl ??
      (async (_tx: unknown, _t: string, cid: string) => {
        const found = args.cycles.find((c) => c.cycleId === cid);
        return { ...found!, status: 'lapsed' as const };
      }),
  );
  const acquireLockMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(args.emitInTxImpl ?? (async () => {}));
  const emitMock = vi.fn(args.emitImpl ?? (async () => {}));
  const countMock = vi.fn(
    args.countImpl ??
      (async (input: { invoiceId: string }) =>
        args.failedAttemptsByInvoice?.get(input.invoiceId) ?? 0),
  );
  const f5Bridge: F5PaymentAttemptsBridge = {
    countFailedAttemptsForInvoice: countMock as never,
  };
  const invoiceDueMock = vi.fn(args.invoiceDueImpl ?? (async () => null));
  const invoiceDueBridge: InvoiceDueBridge = {
    // 065 §5.2 — retained on the port but no longer consulted by the lapse
    // cron; stub it so the InvoiceDueBridge type is satisfied.
    hasUnpaidNotYetDueMembershipInvoice: vi.fn(async () => false) as never,
    oldestUnpaidMembershipInvoiceDueDate: invoiceDueMock as never,
  };

  const findByTenantMock = vi.fn(async () =>
    args.settings === undefined
      ? ({
          tenantId: TENANT_ID,
          gracePeriodDays: 14,
          autoUpgradeEnabled: true,
          minTenureDaysForAtRisk: 30,
          dispatchCronEnabled: true,
          replyToEmail: null,
          replyToDisplayName: null,
          // Round 5 staff-review (K24-S3): required ISO timestamps on
          // the Domain shape — without these the cast bypassed TS's
          // structural check + future use-case extensions touching
          // these fields would silently get undefined in tests.
          createdAt: '2026-05-08T00:00:00Z',
          updatedAt: '2026-05-08T00:00:00Z',
        } as TenantRenewalSettings)
      : args.settings,
  );

  const deps: LapseCyclesOnGraceExpiryDeps = {
    tenant: { slug: TENANT_ID } as LapseCyclesOnGraceExpiryDeps['tenant'],
    cyclesRepo: {
      listCyclesEligibleForLapse: listMock,
      findByIdInTx: findByIdInTxMock,
      transitionStatus: transitionMock,
      acquireCycleLockInTx: acquireLockMock,
    } as unknown as LapseCyclesOnGraceExpiryDeps['cyclesRepo'],
    auditEmitter: {
      emit: emitMock,
      emitInTx: emitInTxMock,
    } as unknown as LapseCyclesOnGraceExpiryDeps['auditEmitter'],
    tenantRenewalSettingsRepo: {
      findByTenant: findByTenantMock,
      upsert: vi.fn(),
    },
    f5PaymentAttemptsBridge: f5Bridge,
    invoiceDueBridge,
  };
  return { deps, emitInTxMock, emitMock, countMock, transitionMock, invoiceDueMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  now: NOW,
  correlationId: 'corr-lapse-1',
};

describe('lapseCyclesOnGraceExpiry (T115a) — decision branch', () => {
  it('grace_expired: zero F5 failed attempts → transitions with closed_reason=grace_expired + emits renewal_lapsed', async () => {
    const cycle = expiredCycle({ daysPastGrace: 1 });
    const { deps, emitInTxMock, transitionMock } = fakeDeps({
      cycles: [cycle],
      failedAttemptsByInvoice: new Map([[INVOICE_UUID, 0]]),
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(1);
      expect(r.value.graceExpired).toBe(1);
      expect(r.value.paymentFailed).toBe(0);
      expect(r.value.transitionRaceSkipped).toBe(0);
      expect(r.value.errors).toBe(0);
    }
    // Transition with grace_expired
    expect(transitionMock).toHaveBeenCalledOnce();
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      from: 'awaiting_payment',
      to: 'lapsed',
      closedReason: 'grace_expired',
    });
    // Audit emit with the typed payload
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'renewal_lapsed',
      payload: expect.objectContaining({
        closed_reason: 'grace_expired',
        grace_period_days: 14,
        failed_payment_attempts: 0,
      }),
    });
  });

  it('payment_failed: ≥1 F5 failed attempt → transitions with closed_reason=payment_failed', async () => {
    const cycle = expiredCycle({ daysPastGrace: 5 });
    const { deps, emitInTxMock, transitionMock } = fakeDeps({
      cycles: [cycle],
      failedAttemptsByInvoice: new Map([[INVOICE_UUID, 2]]),
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.graceExpired).toBe(0);
      expect(r.value.paymentFailed).toBe(1);
    }
    expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
      closedReason: 'payment_failed',
    });
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      payload: expect.objectContaining({
        closed_reason: 'payment_failed',
        failed_payment_attempts: 2,
      }),
    });
  });

  it('null linkedInvoiceId: defaults to grace_expired without calling F5 bridge', async () => {
    const cycle = expiredCycle({ linkedInvoiceId: null });
    const { deps, countMock } = fakeDeps({ cycles: [cycle] });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.graceExpired).toBe(1);
    expect(countMock).not.toHaveBeenCalled();
  });

  it('race-loss skip: cycle moved out of awaiting_payment between list + re-read → counted in transitionRaceSkipped', async () => {
    const cycle = expiredCycle({});
    const { deps, transitionMock } = fakeDeps({
      cycles: [cycle],
      reReadCycle: () =>
        ({ ...cycle, status: 'completed' as const }) as RenewalCycle,
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.transitionRaceSkipped).toBe(1);
      expect(r.value.graceExpired).toBe(0);
    }
    expect(transitionMock).not.toHaveBeenCalled();
  });

  it('K24-Tests-1: race-loss via CycleTransitionConflictError thrown by transitionStatus → counted in transitionRaceSkipped, NOT errors', async () => {
    // Round 5 staff-review (K24-Tests-1): the SECOND race-skip path
    // (concurrent admin-mark-paid wins between findByIdInTx + transitionStatus
    // calls inside the same tx). The previous race-loss test only covers
    // the first path (re-read finds non-awaiting_payment cycle); this
    // case verifies that a conflict thrown by transitionStatus itself is
    // also discriminated correctly (NOT propagated as a generic error).
    const cycle = expiredCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new CycleTransitionConflictError(
          cycle.cycleId,
          'awaiting_payment',
          'completed',
        );
      },
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.transitionRaceSkipped).toBe(1);
      expect(r.value.errors).toBe(0);
      expect(r.value.graceExpired).toBe(0);
    }
  });

  it('K24-Tests-1b: CycleNotFoundError thrown by transitionStatus → also counted in transitionRaceSkipped', async () => {
    const cycle = expiredCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new CycleNotFoundError(cycle.cycleId);
      },
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.transitionRaceSkipped).toBe(1);
      expect(r.value.errors).toBe(0);
    }
  });

  it('K24-Tests-1c: generic Error thrown by transitionStatus → re-thrown + counted in errors (NOT race-skipped)', async () => {
    const cycle = expiredCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      transitionImpl: async () => {
        throw new Error('db connection lost mid-transition');
      },
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.errors).toBe(1);
      expect(r.value.transitionRaceSkipped).toBe(0);
    }
  });

  it('K24-Tests-2: acquireCycleLockInTx is invoked with (tx, tenantId, cycleId) — Principle VIII concurrency-defence lock', async () => {
    // Round 5 staff-review (K24-Tests-2): a regression that drops the
    // advisory-lock acquisition (e.g. moves it outside the tx, removes
    // it during refactor) would silently weaken concurrency safety.
    // Lock the contract explicitly.
    const cycle = expiredCycle({});
    const fake = fakeDeps({ cycles: [cycle] });
    const acquireLockMock = fake.deps.cyclesRepo
      .acquireCycleLockInTx as unknown as ReturnType<typeof vi.fn>;
    await lapseCyclesOnGraceExpiry(fake.deps, baseInput);
    expect(acquireLockMock).toHaveBeenCalledTimes(1);
    expect(acquireLockMock).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      cycle.cycleId,
    );
  });

  it('K24-Tests-3: audit emit failure inside tx → counted in errors (Principle VIII reverse-direction rolls tx back; per-cycle catch absorbs)', async () => {
    // Round 5 staff-review (K24-Tests-3): the use-case relies on
    // emitInTx-throws → runInTenant-rollback → outer catch increments
    // errors. The mock runInTenant is a passthrough so no real rollback
    // happens, but the throw still propagates to the per-cycle catch
    // which is the assertion here.
    const cycle = expiredCycle({});
    const { deps } = fakeDeps({
      cycles: [cycle],
      emitInTxImpl: async () => {
        throw new Error('audit_log: insert failed');
      },
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.errors).toBe(1);
      expect(r.value.graceExpired).toBe(0); // rollback prevents tally bump
    }
  });

  it('per-cycle error isolation: F5 bridge throws → counted in errors + cron continues', async () => {
    const cycleA = expiredCycle({ cycleSuffix: 'c001' });
    const cycleB = expiredCycle({ cycleSuffix: 'c002' });
    const { deps } = fakeDeps({
      cycles: [cycleA, cycleB],
      countImpl: vi
        .fn()
        .mockRejectedValueOnce(new Error('F5 bridge connection lost'))
        .mockResolvedValueOnce(0),
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(2);
      expect(r.value.errors).toBe(1);
      expect(r.value.graceExpired).toBe(1); // cycleB succeeded
    }
  });

  it('tenant_settings_not_found: settings repo returns null', async () => {
    const { deps } = fakeDeps({ cycles: [], settings: null });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('tenant_settings_not_found');
  });

  it('invalid_input: missing required field → invalid_input error from parseInput', async () => {
    const { deps } = fakeDeps({ cycles: [] });
    const r = await lapseCyclesOnGraceExpiry(
      deps,
      // @ts-expect-error testing the runtime guard
      { tenantId: TENANT_ID, now: NOW },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  describe('065 §5.2 — InvoiceDueBridge due-date decision (runs BEFORE the advisory-lock tx)', () => {
    // NOW = 2026-05-08 → bangkokLocalDate(NOW) = '2026-05-08'. A due date
    // AT/AFTER today is not-yet-due (defer); a due date > 60 days in the
    // past falls through to terminate.
    const NOT_YET_DUE_DATE = '2026-06-01'; // >= todayBkk → defer
    const PAST_DUE_PLUS_60 = '2026-01-01'; // today > due+60 → terminate

    it('unpaid not-yet-due membership invoice → defers lapse (deferred_invoice_not_due), no DB transition, audit via emit() not emitInTx()', async () => {
      const cycle = expiredCycle({});
      const { deps, transitionMock, emitInTxMock, emitMock, invoiceDueMock } =
        fakeDeps({
          cycles: [cycle],
          invoiceDueImpl: async () => NOT_YET_DUE_DATE,
        });
      const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.cyclesProcessed).toBe(1);
        expect(r.value.deferredInvoiceNotDue).toBe(1);
        expect(r.value.graceExpired).toBe(0);
        expect(r.value.paymentFailed).toBe(0);
        expect(r.value.errors).toBe(0);
      }
      // No state transition — the member is NOT lapsed.
      expect(transitionMock).not.toHaveBeenCalled();
      // The atomic-with-state-change `emitInTx` path is untouched...
      expect(emitInTxMock).not.toHaveBeenCalled();
      // ...instead the fire-and-forget `emit()` records the deferral,
      // since there is no state-change tx to piggyback on.
      expect(emitMock).toHaveBeenCalledOnce();
      expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
        type: 'renewal_lapse_deferred_invoice_not_due',
        payload: expect.objectContaining({
          cycle_id: cycle.cycleId,
          invoice_subject: 'membership',
        }),
      });
      // Guard consulted with the cycle's member + tenant + today's Bangkok date.
      expect(invoiceDueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT_ID,
          memberId: cycle.memberId,
        }),
      );
    });

    it('no membership invoice + expires_at past grace → backstop terminates (grace_expired), guard consulted once', async () => {
      // daysPastGrace default 1 → expires_at = NOW - 15d; grace = 14 →
      // backstop cutoff = NOW - 14d; expires < cutoff → fall through to
      // terminate.
      const cycle = expiredCycle({});
      const { deps, invoiceDueMock, transitionMock } = fakeDeps({
        cycles: [cycle],
        invoiceDueImpl: async () => null,
      });
      const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.graceExpired).toBe(1);
        expect(r.value.deferredInvoiceNotDue).toBe(0);
        expect(r.value.deferredNoInvoiceBackstop).toBe(0);
        expect(r.value.deferredGuardErrors).toBe(0);
      }
      expect(invoiceDueMock).toHaveBeenCalledOnce();
      expect(transitionMock).toHaveBeenCalledOnce();
    });

    it('past due but within due+60 window → deferred_within_termination_window (no transition, no audit)', async () => {
      const cycle = expiredCycle({});
      const { deps, transitionMock, emitMock, emitInTxMock } = fakeDeps({
        cycles: [cycle],
        // Due 2026-05-01 (before today 2026-05-08) but due+60 = 2026-06-30
        // is in the future → stay suspended, re-check tomorrow.
        invoiceDueImpl: async () => '2026-05-01',
      });
      const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.deferredWithinTerminationWindow).toBe(1);
        expect(r.value.graceExpired).toBe(0);
        expect(r.value.deferredInvoiceNotDue).toBe(0);
        expect(r.value.errors).toBe(0);
      }
      expect(transitionMock).not.toHaveBeenCalled();
      // No forensic audit on this benign "keep suspended" path (only the
      // not-yet-due branch emits).
      expect(emitMock).not.toHaveBeenCalled();
      expect(emitInTxMock).not.toHaveBeenCalled();
    });

    it('today > due+60 → falls through to terminate (grace_expired when no F5 failures)', async () => {
      const cycle = expiredCycle({});
      const { deps, transitionMock } = fakeDeps({
        cycles: [cycle],
        // Due 2026-01-01 → due+60 = 2026-03-02, well before today 2026-05-08.
        invoiceDueImpl: async () => PAST_DUE_PLUS_60,
      });
      const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.graceExpired).toBe(1);
      expect(transitionMock).toHaveBeenCalledOnce();
      expect(transitionMock.mock.calls[0]?.[3]).toMatchObject({
        closedReason: 'grace_expired',
      });
    });

    it('no membership invoice + expires_at still inside grace → deferred_no_invoice_backstop (no transition)', async () => {
      // expires_at only 1 day past expiry — still inside the 14-day grace
      // backstop (cutoff = NOW - 14d; expires = NOW - 1d ≥ cutoff → defer).
      const cycle = buildCycleShared({
        cycleId: '00000000-0000-0000-0000-00000000c009' as never,
        status: 'awaiting_payment',
        expiresAt: new Date(NOW.getTime() - 1 * 86_400_000).toISOString(),
        linkedInvoiceId: null,
      });
      const { deps, transitionMock } = fakeDeps({
        cycles: [cycle],
        invoiceDueImpl: async () => null,
      });
      const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.deferredNoInvoiceBackstop).toBe(1);
        expect(r.value.graceExpired).toBe(0);
        expect(r.value.errors).toBe(0);
      }
      expect(transitionMock).not.toHaveBeenCalled();
    });

    it('guard throws → fails SAFE (member NOT lapsed), outcome deferred_guard_error — NOT folded into errors, observable via metric + logger.error', async () => {
      const metricSpy = vi.spyOn(
        renewalsMetrics.lapseInvoiceDueGuardErrors,
        'add',
      );
      const loggerSpy = vi
        .spyOn(logger, 'error')
        .mockImplementation(() => logger);
      try {
        const cycle = expiredCycle({});
        const { deps, transitionMock, emitInTxMock, emitMock } = fakeDeps({
          cycles: [cycle],
          invoiceDueImpl: async () => {
            throw new Error('bridge connection lost');
          },
        });
        const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.value.deferredGuardErrors).toBe(1);
          // Distinguishable from the generic per-cycle error tally —
          // a guard throw must not be an invisible silent skip folded
          // into `errors`.
          expect(r.value.errors).toBe(0);
          expect(r.value.graceExpired).toBe(0);
          expect(r.value.paymentFailed).toBe(0);
        }
        expect(transitionMock).not.toHaveBeenCalled();
        expect(emitInTxMock).not.toHaveBeenCalled();
        expect(emitMock).not.toHaveBeenCalled();
        expect(metricSpy).toHaveBeenCalledWith(1, { tenant_id: TENANT_ID });
        expect(loggerSpy).toHaveBeenCalled();
      } finally {
        metricSpy.mockRestore();
        loggerSpy.mockRestore();
      }
    });
  });

  it('multi-cycle mix: 2 grace_expired + 1 payment_failed in one run', async () => {
    const c1 = expiredCycle({ cycleSuffix: 'c001' });
    const c2 = expiredCycle({ cycleSuffix: 'c002' });
    const c3 = expiredCycle({ cycleSuffix: 'c003' });
    // c2 has linkedInvoiceId = c2's invoice (custom), with 1 failed attempt
    const c2Invoice = '00000000-0000-0000-0000-0000000bbbb2';
    const c2WithInvoice = { ...c2, linkedInvoiceId: c2Invoice } as RenewalCycle;
    const { deps } = fakeDeps({
      cycles: [c1, c2WithInvoice, c3],
      countImpl: vi.fn(async (input: { invoiceId: string }) =>
        input.invoiceId === c2Invoice ? 1 : 0,
      ),
    });
    const r = await lapseCyclesOnGraceExpiry(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.cyclesProcessed).toBe(3);
      expect(r.value.graceExpired).toBe(2);
      expect(r.value.paymentFailed).toBe(1);
    }
  });
});
