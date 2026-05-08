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
import { buildCycle as buildCycleShared } from '../../_helpers/build-cycle';

const TENANT_ID = 'tenantA';
const NOW = new Date('2026-05-08T00:00:00Z');
const INVOICE_UUID = '00000000-0000-0000-0000-0000000bbbb1';

vi.mock('@/lib/db', () => ({
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
  transitionImpl?: () => Promise<RenewalCycle>;
}): {
  deps: LapseCyclesOnGraceExpiryDeps;
  emitInTxMock: ReturnType<typeof vi.fn>;
  countMock: ReturnType<typeof vi.fn>;
  transitionMock: ReturnType<typeof vi.fn>;
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
  const countMock = vi.fn(
    args.countImpl ??
      (async (input: { invoiceId: string }) =>
        args.failedAttemptsByInvoice?.get(input.invoiceId) ?? 0),
  );
  const f5Bridge: F5PaymentAttemptsBridge = {
    countFailedAttemptsForInvoice: countMock as never,
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
      emit: vi.fn(),
      emitInTx: emitInTxMock,
    } as unknown as LapseCyclesOnGraceExpiryDeps['auditEmitter'],
    tenantRenewalSettingsRepo: {
      findByTenant: findByTenantMock,
      upsert: vi.fn(),
    },
    f5PaymentAttemptsBridge: f5Bridge,
  };
  return { deps, emitInTxMock, countMock, transitionMock };
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
