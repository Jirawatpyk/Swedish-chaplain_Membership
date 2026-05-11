/**
 * F8 Phase 6 Wave B · T154 spec — `computeAtRiskScore` use-case.
 *
 * Verifies orchestration over the AtRiskScorer port + persistence +
 * audit emit-in-tx + band-crossing detection (FR-031). The Domain
 * formula itself has its own property-based test (T172) at
 * `tests/unit/renewals/domain/at-risk-score.test.ts`; this test
 * focuses on the Application-layer orchestration.
 */
import { describe, expect, it, vi } from 'vitest';
import { computeAtRiskScore } from '@/modules/renewals/application/use-cases/compute-at-risk-score';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type {
  AtRiskScoreResult,
  AtRiskFactors,
  AtRiskComputeContext,
} from '@/modules/renewals/domain/at-risk-score';
import { computeAtRiskScore as domainCompute } from '@/modules/renewals/domain/at-risk-score';

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a154';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function unwrap(
  factors: AtRiskFactors,
  ctx: AtRiskComputeContext,
): AtRiskScoreResult {
  const r = domainCompute(factors, ctx);
  if (!r.ok) throw new Error('unreachable');
  return r.value;
}

function fakeDeps(opts: {
  scoreResult: AtRiskScoreResult;
  setRiskScoreResult?: { previousBand: string | null; affectedRows: number };
  emitImpl?: () => Promise<void>;
}): {
  deps: RenewalsDeps;
  scorerMock: ReturnType<typeof vi.fn>;
  setMock: ReturnType<typeof vi.fn>;
  emitMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const scorerMock = vi.fn(async () => opts.scoreResult);
  const setMock = vi.fn(
    async () =>
      opts.setRiskScoreResult ?? {
        previousBand: null,
        affectedRows: 1,
      },
  );
  const emitMock = vi.fn(async () => {});
  const emitInTxMock = vi.fn(opts.emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    atRiskScorer: { scoreMember: scorerMock },
    memberRenewalFlagsRepo: { setRiskScore: setMock },
    auditEmitter: { emit: emitMock, emitInTx: emitInTxMock },
  } as unknown as RenewalsDeps;
  return { deps, scorerMock, setMock, emitMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  memberId: MEMBER_UUID,
  correlationId: 'corr-1',
};

describe('computeAtRiskScore (T154)', () => {
  it('happy path — F6-active 60 score persists + emits at_risk_score_recomputed', async () => {
    // AS1 spec example: 25+25+10=60 (events_12mo=0, invoices_overdue=1, days_since_payment=280)
    const scoreResult = unwrap(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 0,
        invoicesOverdueCount: 1,
        daysSinceLastPayment: 280,
      },
      { minTenureDays: 30, eventAttendeesAvailable: true },
    );
    expect(scoreResult.score).toBe(60);
    expect(scoreResult.band).toBe('at-risk');
    const { deps, setMock, emitInTxMock } = fakeDeps({
      scoreResult,
      setRiskScoreResult: { previousBand: null, affectedRows: 1 },
    });
    const r = await computeAtRiskScore(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && !r.value.skipped) {
      expect(r.value.score).toBe(60);
      expect(r.value.band).toBe('at-risk');
      expect(r.value.f6Active).toBe(true);
      expect(r.value.bandCrossedUp).toBe(false); // previousBand was null (first compute)
    }
    expect(setMock).toHaveBeenCalledOnce();
    expect(setMock.mock.calls[0]?.[3]).toMatchObject({
      score: 60,
      band: 'at-risk',
    });
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'at_risk_score_recomputed',
      payload: {
        member_id: MEMBER_UUID,
        score: 60,
        threshold_band: 'at-risk',
        active_max: 100,
        f6_active: true,
      },
    });
  });

  it('band crossed UP — emits at_risk_score_threshold_crossed (FR-031)', async () => {
    const scoreResult = unwrap(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 0,
        invoicesOverdueCount: 1,
        daysSinceLastPayment: 280,
      },
      { minTenureDays: 30, eventAttendeesAvailable: true },
    );
    // Prior band 'warning' (score 25-49); new band 'at-risk' (50). UP transition.
    const { deps, emitInTxMock } = fakeDeps({
      scoreResult,
      setRiskScoreResult: { previousBand: 'warning', affectedRows: 1 },
    });
    const r = await computeAtRiskScore(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && !r.value.skipped) {
      expect(r.value.bandCrossedUp).toBe(true);
      expect(r.value.previousBand).toBe('warning');
    }
    expect(emitInTxMock).toHaveBeenCalledTimes(2);
    const crossingEmit = emitInTxMock.mock.calls[1]?.[1];
    expect(crossingEmit).toMatchObject({
      type: 'at_risk_score_threshold_crossed',
      payload: {
        member_id: MEMBER_UUID,
        previous_band: 'warning',
        new_band: 'at-risk',
        score: 60,
      },
    });
  });

  it('band crossed DOWN — does NOT emit threshold_crossed (only up-deteriorations per FR-031)', async () => {
    const scoreResult = unwrap(
      { tenureDays: 365, eBlastQuotaPctUsed: 25 }, // score 15
      { minTenureDays: 30, eventAttendeesAvailable: true },
    );
    expect(scoreResult.score).toBe(15);
    expect(scoreResult.band).toBe('healthy');
    // Prior 'critical', new 'healthy' — improvement, silent.
    const { deps, emitInTxMock } = fakeDeps({
      scoreResult,
      setRiskScoreResult: { previousBand: 'critical', affectedRows: 1 },
    });
    const r = await computeAtRiskScore(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && !r.value.skipped) {
      expect(r.value.bandCrossedUp).toBe(false);
    }
    // Only the score_recomputed audit; no threshold_crossed.
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
  });

  // Phase 6 review I9 — exhaustive UP-only band-crossed coverage.
  // Spec FR-031 mandates at_risk_score_threshold_crossed emit on every
  // UP arm; previously only warning→at-risk had a test. The 6 valid UP
  // arms exercise distinct switch arms in the use-case (compute-at-
  // risk-score.ts:282-336 + recompute-at-risk-scores-batch.ts:254-284)
  // — a regression in any arm now fails this parametric test.
  it.each([
    // [tenure, factors..., expectedScore, priorBand, expectedNewBand]
    // healthy → warning (low e-blast; score 15) — band derives via 25%/50% bounds
    [
      365, { eBlastQuotaPctUsed: 25 } as AtRiskFactors, 15, 'healthy' as const,
      'healthy' as const,
    ],
  ])(
    'baseline DOWN/same arm guard — score %i with prior %s leaves new band %s no emit',
    async (tenureDays, factors, expectedScore, prior, expectedBand) => {
      const scoreResult = unwrap(
        { tenureDays, ...factors },
        { minTenureDays: 30, eventAttendeesAvailable: true },
      );
      expect(scoreResult.score).toBe(expectedScore);
      expect(scoreResult.band).toBe(expectedBand);
      const { deps, emitInTxMock } = fakeDeps({
        scoreResult,
        setRiskScoreResult: { previousBand: prior, affectedRows: 1 },
      });
      await computeAtRiskScore(deps, baseInput);
      expect(emitInTxMock).toHaveBeenCalledTimes(1); // recomputed only
    },
  );

  it.each<[
    Parameters<typeof unwrap>[0],
    'healthy' | 'warning' | 'at-risk',
    'warning' | 'at-risk' | 'critical',
  ]>([
    // healthy → warning (score 25-49): need sum exactly in [25, 49]
    [{ tenureDays: 365, eBlastQuotaPctUsed: 25, invoicesOverdueCount: 0, daysSinceLastPayment: 200 }, 'healthy', 'warning'], // 15+10=25
    // healthy → at-risk (50-74): events_12mo=0 + overdue → 25+25=50
    [{ tenureDays: 365, eventsAttendedLast12Months: 0, invoicesOverdueCount: 1 }, 'healthy', 'at-risk'],
    // healthy → critical (>=75): events_12mo=0 + e_blast + ticket + overdue + tier-down → 25+15+10+25+15=90 → critical
    [
      { tenureDays: 365, eventsAttendedLast12Months: 0, eBlastQuotaPctUsed: 25, culturalTicketQuotaPctUsed: 25, invoicesOverdueCount: 1, tierDowngradedLast12Months: true },
      'healthy', 'critical',
    ],
    // warning → at-risk (already covered above; included for completeness)
    [{ tenureDays: 365, eventsAttendedLast12Months: 0, invoicesOverdueCount: 1, daysSinceLastPayment: 280 }, 'warning', 'at-risk'],
    // warning → critical (75+): events_12mo + e_blast + ticket + overdue + tier-down = 90
    [
      { tenureDays: 365, eventsAttendedLast12Months: 0, eBlastQuotaPctUsed: 25, culturalTicketQuotaPctUsed: 25, invoicesOverdueCount: 1, tierDowngradedLast12Months: true },
      'warning', 'critical',
    ],
    // at-risk → critical (75+)
    [
      { tenureDays: 365, eventsAttendedLast12Months: 0, eBlastQuotaPctUsed: 25, culturalTicketQuotaPctUsed: 25, invoicesOverdueCount: 1, tierDowngradedLast12Months: true },
      'at-risk', 'critical',
    ],
  ])(
    'UP transition %s → %s emits at_risk_score_threshold_crossed (FR-031)',
    async (factors, prior, expectedBand) => {
      const scoreResult = unwrap(factors, {
        minTenureDays: 30,
        eventAttendeesAvailable: true,
      });
      expect(scoreResult.band).toBe(expectedBand);
      const { deps, emitInTxMock } = fakeDeps({
        scoreResult,
        setRiskScoreResult: { previousBand: prior, affectedRows: 1 },
      });
      await computeAtRiskScore(deps, baseInput);
      expect(emitInTxMock).toHaveBeenCalledTimes(2);
      const crossingEmit = emitInTxMock.mock.calls[1]?.[1] as {
        type: string;
        payload: { previous_band: string; new_band: string };
      };
      expect(crossingEmit.type).toBe('at_risk_score_threshold_crossed');
      expect(crossingEmit.payload.previous_band).toBe(prior);
      expect(crossingEmit.payload.new_band).toBe(expectedBand);
    },
  );

  it('same band — does NOT emit threshold_crossed', async () => {
    const scoreResult = unwrap(
      {
        tenureDays: 365,
        eventsAttendedLast12Months: 0,
        invoicesOverdueCount: 1,
        daysSinceLastPayment: 280,
      },
      { minTenureDays: 30, eventAttendeesAvailable: true },
    );
    const { deps, emitInTxMock } = fakeDeps({
      scoreResult,
      setRiskScoreResult: { previousBand: 'at-risk', affectedRows: 1 },
    });
    await computeAtRiskScore(deps, baseInput);
    expect(emitInTxMock).toHaveBeenCalledTimes(1); // only recomputed
  });

  it('min-tenure skip — emits at_risk_skipped_below_min_tenure + ok({ skipped: true })', async () => {
    const scoreResult = unwrap(
      { tenureDays: 15 },
      { minTenureDays: 30, eventAttendeesAvailable: true },
    );
    expect(scoreResult.skippedBelowMinTenure).toBe(true);
    const { deps, setMock, emitMock, emitInTxMock } = fakeDeps({
      scoreResult,
    });
    const r = await computeAtRiskScore(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.skipped).toBe(true);
      if (r.value.skipped) {
        expect(r.value.reason).toBe('below_min_tenure');
      }
    }
    expect(setMock).not.toHaveBeenCalled();
    // Skip emit uses fire-and-forget `emit`, NOT `emitInTx`.
    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'at_risk_skipped_below_min_tenure',
      payload: { member_id: MEMBER_UUID },
    });
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('F6-inactive mode — active_max=70 audit field correct', async () => {
    const scoreResult = unwrap(
      { tenureDays: 365, invoicesOverdueCount: 1, eBlastQuotaPctUsed: 10 },
      { minTenureDays: 30, eventAttendeesAvailable: false },
    );
    // F6 inactive: events factors skipped; e-blast(15) + invoices(25) = 40.
    expect(scoreResult.activeMax).toBe(70);
    expect(scoreResult.eventAttendanceFactorSkipped).toBe(true);
    const { deps, emitInTxMock } = fakeDeps({
      scoreResult,
      setRiskScoreResult: { previousBand: null, affectedRows: 1 },
    });
    const r = await computeAtRiskScore(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok && !r.value.skipped) {
      expect(r.value.f6Active).toBe(false);
    }
    const recomputeEmit = emitInTxMock.mock.calls[0]?.[1];
    expect(recomputeEmit?.payload).toMatchObject({
      active_max: 70,
      f6_active: false,
    });
  });

  it('member_not_found when affectedRows=0 (RLS-hidden)', async () => {
    const scoreResult = unwrap(
      { tenureDays: 365 },
      { minTenureDays: 30, eventAttendeesAvailable: true },
    );
    const { deps, emitInTxMock } = fakeDeps({
      scoreResult,
      setRiskScoreResult: { previousBand: null, affectedRows: 0 },
    });
    const r = await computeAtRiskScore(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('member_not_found');
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('scorer throws — server_error (cron loop catches + counts)', async () => {
    const scorerError = new Error('CTE query timed out');
    const deps = {
      tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
      atRiskScorer: {
        scoreMember: vi.fn(async () => {
          throw scorerError;
        }),
      },
      memberRenewalFlagsRepo: { setRiskScore: vi.fn() },
      auditEmitter: { emit: vi.fn(), emitInTx: vi.fn() },
    } as unknown as RenewalsDeps;
    const r = await computeAtRiskScore(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('server_error');
      if (r.error.kind === 'server_error') {
        expect(r.error.message).toContain('CTE query timed out');
      }
    }
  });

  it('audit emit fail rolls back state-write (Principle VIII)', async () => {
    const scoreResult = unwrap(
      { tenureDays: 365, invoicesOverdueCount: 1 },
      { minTenureDays: 30, eventAttendeesAvailable: true },
    );
    const auditError = new Error('audit_log: insert failed');
    const { deps } = fakeDeps({
      scoreResult,
      setRiskScoreResult: { previousBand: null, affectedRows: 1 },
      emitImpl: async () => {
        throw auditError;
      },
    });
    await expect(computeAtRiskScore(deps, baseInput)).rejects.toThrow(
      auditError,
    );
  });

  it('invalid input — non-uuid memberId rejected', async () => {
    const { deps } = fakeDeps({
      scoreResult: unwrap(
        { tenureDays: 365 },
        { minTenureDays: 30, eventAttendeesAvailable: true },
      ),
    });
    const r = await computeAtRiskScore(deps, {
      ...baseInput,
      memberId: 'not-a-uuid',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });
});
