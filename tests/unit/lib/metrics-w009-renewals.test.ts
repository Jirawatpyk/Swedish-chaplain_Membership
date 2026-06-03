/**
 * W0-09 go-live finding — Unit tests for the missing F8 renewals OTel
 * instruments catalogued in docs/observability.md § 23.1 but previously
 * absent from src/lib/metrics.ts.
 *
 * Pins the instrument NAME, label KEYS, and emission SEMANTICS for each
 * new metric so that dashboard/alert regressions surface at unit-test
 * time rather than at production deploy.
 *
 * Instruments verified here:
 *   1. `renewals.cron_bearer_auth_rejected_total{route}` — F8-A3
 *   2. `renewals.coordinator.tenants_enqueued_total{cron_kind}`
 *   3. `renewals.coordinator.tenants_succeeded_total{cron_kind}`
 *   4. `renewals.coordinator.tenants_failed_total{cron_kind}` — F8-A1
 *   5. `renewals.coordinator.duration_ms{cron_kind}` (histogram)
 *   6. `renewals.at_risk.recompute_members_succeeded_total{tenant_id, band}`
 *   7. `renewals.at_risk.recompute_members_failed_total{tenant_id}`
 *   8. `renewals.at_risk.snooze_total{tenant_id, actor_role}`
 *   9. `renewals.at_risk.outreach_recorded_total{tenant_id, channel, template_id}`
 *  10. `renewals.pipeline.lapsed_tab_visit_total{tenant_id}`
 *
 * Note: `renewals.pipeline.row_count` is an ObservableGauge whose
 * callback mechanism is not exercisable in vitest (no OTel SDK exporter
 * boot); the gauge accumulator path is tested via the existing
 * __test__readGaugeValues accessor pattern below.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Fake meter: captures createCounter + Counter.add + createHistogram +
// Histogram.record + createObservableGauge calls.
// -------------------------------------------------------------------------

interface CapturedCounterAdd {
  readonly value: number;
  readonly attrs: Record<string, unknown>;
}

interface CapturedHistogramRecord {
  readonly value: number;
  readonly attrs: Record<string, unknown>;
}

const counterAddsByName = new Map<string, CapturedCounterAdd[]>();
const histogramRecordsByName = new Map<string, CapturedHistogramRecord[]>();
const observableGaugesCreated = new Set<string>();

function getOrCreateCounterBucket(name: string): CapturedCounterAdd[] {
  let bucket = counterAddsByName.get(name);
  if (!bucket) {
    bucket = [];
    counterAddsByName.set(name, bucket);
  }
  return bucket;
}

function getOrCreateHistogramBucket(name: string): CapturedHistogramRecord[] {
  let bucket = histogramRecordsByName.get(name);
  if (!bucket) {
    bucket = [];
    histogramRecordsByName.set(name, bucket);
  }
  return bucket;
}

vi.mock('@opentelemetry/api', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );
  return {
    ...actual,
    metrics: {
      getMeter: () => ({
        createCounter: (name: string) => ({
          add: (value: number, attrs: Record<string, unknown>) => {
            getOrCreateCounterBucket(name).push({ value, attrs });
          },
        }),
        createHistogram: (name: string) => ({
          record: (value: number, attrs: Record<string, unknown>) => {
            getOrCreateHistogramBucket(name).push({ value, attrs });
          },
        }),
        createObservableGauge: (name: string) => {
          observableGaugesCreated.add(name);
          return { addCallback: () => {} };
        },
      }),
    },
  };
});

// Import AFTER vi.mock so the module picks up the fake meter.
import {
  renewalsMetrics,
  __test__readGaugeValues,
  __test__clearGaugeValues,
} from '@/lib/metrics';

describe('W0-09 — renewalsMetrics missing § 23.1 instruments', () => {
  beforeEach(() => {
    counterAddsByName.clear();
    histogramRecordsByName.clear();
    observableGaugesCreated.clear();
    // code-review #9-#14 Finding 2 — drop the process-level gauge accumulator
    // so a test reusing a tenant+band pair can't read a value bled in from an
    // earlier case (pipelineRowCount persists last-observed values per label).
    __test__clearGaugeValues();
  });

  // -----------------------------------------------------------------------
  // 1. renewals.cron_bearer_auth_rejected_total — F8-A3
  // -----------------------------------------------------------------------
  describe('cronBearerAuthRejected (F8-A3)', () => {
    it('emits `renewals.cron_bearer_auth_rejected_total` with route label', () => {
      renewalsMetrics.cronBearerAuthRejected(
        '/api/cron/renewals/dispatch-coordinator',
      );
      const bucket = counterAddsByName.get(
        'renewals.cron_bearer_auth_rejected_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket).toHaveLength(1);
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: { route: '/api/cron/renewals/dispatch-coordinator' },
      });
    });

    it('uses the route string verbatim — distinct routes produce distinct label series', () => {
      renewalsMetrics.cronBearerAuthRejected('/api/cron/renewals/at-risk-recompute-coordinator');
      renewalsMetrics.cronBearerAuthRejected('/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator');
      const bucket = counterAddsByName.get('renewals.cron_bearer_auth_rejected_total')!;
      expect(bucket).toHaveLength(2);
      expect(bucket[0]!.attrs.route).toBe('/api/cron/renewals/at-risk-recompute-coordinator');
      expect(bucket[1]!.attrs.route).toBe('/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator');
    });

    it('never throws — safeMetric swallow contract holds', () => {
      expect(() =>
        renewalsMetrics.cronBearerAuthRejected('/any/route'),
      ).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // 2-4. renewals.coordinator.tenants_{enqueued,succeeded,failed}_total
  // -----------------------------------------------------------------------
  describe('coordinatorTenantsEnqueued (§ 23.1.3)', () => {
    it('emits `renewals.coordinator.tenants_enqueued_total` with cron_kind + count', () => {
      renewalsMetrics.coordinatorTenantsEnqueued('dispatch', 3);
      const bucket = counterAddsByName.get(
        'renewals.coordinator.tenants_enqueued_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({ value: 3, attrs: { cron_kind: 'dispatch' } });
    });

    it('emits count=0 without throwing (zero-tenant cron pass)', () => {
      expect(() =>
        renewalsMetrics.coordinatorTenantsEnqueued('lapse', 0),
      ).not.toThrow();
      const bucket = counterAddsByName.get('renewals.coordinator.tenants_enqueued_total')!;
      expect(bucket[0]).toEqual({ value: 0, attrs: { cron_kind: 'lapse' } });
    });
  });

  describe('coordinatorTenantsSucceeded (§ 23.1.3)', () => {
    it('emits `renewals.coordinator.tenants_succeeded_total` with cron_kind', () => {
      renewalsMetrics.coordinatorTenantsSucceeded('at_risk_recompute', 2);
      const bucket = counterAddsByName.get(
        'renewals.coordinator.tenants_succeeded_total',
      );
      expect(bucket![0]).toEqual({ value: 2, attrs: { cron_kind: 'at_risk_recompute' } });
    });
  });

  describe('coordinatorTenantsFailed — F8-A1', () => {
    it('emits `renewals.coordinator.tenants_failed_total` with cron_kind — F8-A1 trigger', () => {
      renewalsMetrics.coordinatorTenantsFailed('dispatch', 1);
      const bucket = counterAddsByName.get(
        'renewals.coordinator.tenants_failed_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({ value: 1, attrs: { cron_kind: 'dispatch' } });
    });

    it('emits with count > 1 for multi-tenant failure batches', () => {
      renewalsMetrics.coordinatorTenantsFailed('reconcile', 5);
      const bucket = counterAddsByName.get('renewals.coordinator.tenants_failed_total')!;
      expect(bucket[0]).toEqual({ value: 5, attrs: { cron_kind: 'reconcile' } });
    });

    it('each cron_kind is a distinct label series — no cross-coordinator bleed', () => {
      renewalsMetrics.coordinatorTenantsFailed('dispatch', 1);
      renewalsMetrics.coordinatorTenantsFailed('lapse', 2);
      const bucket = counterAddsByName.get('renewals.coordinator.tenants_failed_total')!;
      expect(bucket).toHaveLength(2);
      expect(bucket[0]!.attrs.cron_kind).toBe('dispatch');
      expect(bucket[1]!.attrs.cron_kind).toBe('lapse');
    });
  });

  // -----------------------------------------------------------------------
  // 5. renewals.coordinator.duration_ms histogram
  // -----------------------------------------------------------------------
  describe('coordinatorDurationMs (§ 23.1.3)', () => {
    it('records `renewals.coordinator.duration_ms` histogram with cron_kind', () => {
      renewalsMetrics.coordinatorDurationMs('dispatch', 12_500);
      const bucket = histogramRecordsByName.get('renewals.coordinator.duration_ms');
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({ value: 12_500, attrs: { cron_kind: 'dispatch' } });
    });

    it('records for all 4 coordinator kinds without throws', () => {
      const kinds = ['dispatch', 'at_risk_recompute', 'lapse', 'reconcile'] as const;
      for (const kind of kinds) {
        expect(() =>
          renewalsMetrics.coordinatorDurationMs(kind, 1000),
        ).not.toThrow();
      }
      const bucket = histogramRecordsByName.get('renewals.coordinator.duration_ms')!;
      expect(bucket).toHaveLength(4);
    });
  });

  // -----------------------------------------------------------------------
  // 6. renewals.at_risk.recompute_members_succeeded_total
  // -----------------------------------------------------------------------
  describe('atRiskRecomputeMembersSucceeded (§ 23.1.2)', () => {
    it('emits `renewals.at_risk.recompute_members_succeeded_total` with tenant_id + band', () => {
      renewalsMetrics.atRiskRecomputeMembersSucceeded('tenant-x', 'at-risk');
      const bucket = counterAddsByName.get(
        'renewals.at_risk.recompute_members_succeeded_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: { tenant_id: 'tenant-x', band: 'at-risk' },
      });
    });

    it('accepts explicit count > 1 (batch path)', () => {
      renewalsMetrics.atRiskRecomputeMembersSucceeded('tenant-y', 'batch', 250);
      const bucket = counterAddsByName.get(
        'renewals.at_risk.recompute_members_succeeded_total',
      )!;
      expect(bucket[0]).toEqual({
        value: 250,
        attrs: { tenant_id: 'tenant-y', band: 'batch' },
      });
    });

    it('defaults count to 1 when omitted', () => {
      renewalsMetrics.atRiskRecomputeMembersSucceeded('tenant-z', 'healthy');
      const bucket = counterAddsByName.get(
        'renewals.at_risk.recompute_members_succeeded_total',
      )!;
      expect(bucket[0]!.value).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 7. renewals.at_risk.recompute_members_failed_total
  // -----------------------------------------------------------------------
  describe('atRiskRecomputeMembersFailed (§ 23.1.2)', () => {
    it('emits `renewals.at_risk.recompute_members_failed_total` with tenant_id', () => {
      renewalsMetrics.atRiskRecomputeMembersFailed('tenant-a');
      const bucket = counterAddsByName.get(
        'renewals.at_risk.recompute_members_failed_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({ value: 1, attrs: { tenant_id: 'tenant-a' } });
    });

    it('accepts explicit count > 1', () => {
      renewalsMetrics.atRiskRecomputeMembersFailed('tenant-b', 17);
      const bucket = counterAddsByName.get(
        'renewals.at_risk.recompute_members_failed_total',
      )!;
      expect(bucket[0]).toEqual({ value: 17, attrs: { tenant_id: 'tenant-b' } });
    });

    it('has no `band` label (§ 23.1.2 spec — failures are not band-labelled)', () => {
      renewalsMetrics.atRiskRecomputeMembersFailed('tenant-c');
      const bucket = counterAddsByName.get(
        'renewals.at_risk.recompute_members_failed_total',
      )!;
      expect(bucket[0]!.attrs).not.toHaveProperty('band');
    });
  });

  // -----------------------------------------------------------------------
  // 8. renewals.at_risk.snooze_total
  // -----------------------------------------------------------------------
  describe('atRiskSnooze (§ 23.1.2)', () => {
    it('emits `renewals.at_risk.snooze_total` with tenant_id + actor_role', () => {
      renewalsMetrics.atRiskSnooze('tenant-snooze', 'admin');
      const bucket = counterAddsByName.get('renewals.at_risk.snooze_total');
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: { tenant_id: 'tenant-snooze', actor_role: 'admin' },
      });
    });

    it('always adds exactly 1 per invocation', () => {
      renewalsMetrics.atRiskSnooze('t', 'admin');
      renewalsMetrics.atRiskSnooze('t', 'admin');
      const bucket = counterAddsByName.get('renewals.at_risk.snooze_total')!;
      expect(bucket.every((c) => c.value === 1)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 9. renewals.at_risk.outreach_recorded_total
  // -----------------------------------------------------------------------
  describe('atRiskOutreachRecorded (§ 23.1.2)', () => {
    it('emits `renewals.at_risk.outreach_recorded_total` with email channel + template_id', () => {
      renewalsMetrics.atRiskOutreachRecorded('tenant-o', 'email', 'tmpl-abc');
      const bucket = counterAddsByName.get(
        'renewals.at_risk.outreach_recorded_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: {
          tenant_id: 'tenant-o',
          channel: 'email',
          template_id: 'tmpl-abc',
        },
      });
    });

    it('uses template_id="none" when channel is phone (no template)', () => {
      renewalsMetrics.atRiskOutreachRecorded('tenant-p', 'phone', undefined);
      const bucket = counterAddsByName.get(
        'renewals.at_risk.outreach_recorded_total',
      )!;
      expect(bucket[0]).toEqual({
        value: 1,
        attrs: { tenant_id: 'tenant-p', channel: 'phone', template_id: 'none' },
      });
    });

    it('uses template_id="none" for meeting channel', () => {
      renewalsMetrics.atRiskOutreachRecorded('tenant-q', 'meeting', undefined);
      const bucket = counterAddsByName.get(
        'renewals.at_risk.outreach_recorded_total',
      )!;
      expect(bucket[0]!.attrs.template_id).toBe('none');
    });
  });

  // -----------------------------------------------------------------------
  // 10. renewals.pipeline.lapsed_tab_visit_total
  // -----------------------------------------------------------------------
  describe('pipelineLapsedTabVisit (§ 23.1.1)', () => {
    it('emits `renewals.pipeline.lapsed_tab_visit_total` with tenant_id', () => {
      renewalsMetrics.pipelineLapsedTabVisit('tenant-lapsed');
      const bucket = counterAddsByName.get(
        'renewals.pipeline.lapsed_tab_visit_total',
      );
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: { tenant_id: 'tenant-lapsed' },
      });
    });

    it('always adds exactly 1 per visit', () => {
      renewalsMetrics.pipelineLapsedTabVisit('t');
      renewalsMetrics.pipelineLapsedTabVisit('t');
      const bucket = counterAddsByName.get('renewals.pipeline.lapsed_tab_visit_total')!;
      expect(bucket.every((c) => c.value === 1)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // 11. renewals.pipeline.row_count (ObservableGauge accumulator)
  // -----------------------------------------------------------------------
  describe('pipelineRowCount (§ 23.1.1 gauge)', () => {
    // code-review #10 — pipelineRowCount now routes through the generic
    // `observeGauge` helper, whose inner-map key is the stable JSON of the
    // sorted labels ({tenant_id, urgency_band}) rather than the old
    // `tenant:band` colon composite. OTel scrape output is identical; only
    // this internal accumulator key changed.
    const gaugeKey = (tenantId: string, urgencyBand: string): string =>
      JSON.stringify({ tenant_id: tenantId, urgency_band: urgencyBand });

    it('writes to gaugeValues accumulator keyed by sorted-label JSON', () => {
      renewalsMetrics.pipelineRowCount('tenant-rg', 't-30', 42);
      const bucket = __test__readGaugeValues('renewals.pipeline.row_count');
      expect(bucket).toBeDefined();
      expect(bucket!.get(gaugeKey('tenant-rg', 't-30'))).toBe(42);
    });

    it('overwrites on re-observe — accumulator reports most-recent value', () => {
      renewalsMetrics.pipelineRowCount('tenant-rg2', 'all', 10);
      renewalsMetrics.pipelineRowCount('tenant-rg2', 'all', 75);
      const bucket = __test__readGaugeValues('renewals.pipeline.row_count')!;
      expect(bucket.get(gaugeKey('tenant-rg2', 'all'))).toBe(75);
    });

    it('different urgency_band values produce independent keys', () => {
      renewalsMetrics.pipelineRowCount('tenant-rg3', 't-30', 100);
      renewalsMetrics.pipelineRowCount('tenant-rg3', 'lapsed', 5);
      const bucket = __test__readGaugeValues('renewals.pipeline.row_count')!;
      expect(bucket.get(gaugeKey('tenant-rg3', 't-30'))).toBe(100);
      expect(bucket.get(gaugeKey('tenant-rg3', 'lapsed'))).toBe(5);
    });

    it('zero row count is observable', () => {
      renewalsMetrics.pipelineRowCount('tenant-rg4', 'grace', 0);
      const bucket = __test__readGaugeValues('renewals.pipeline.row_count')!;
      expect(bucket.has(gaugeKey('tenant-rg4', 'grace'))).toBe(true);
      expect(bucket.get(gaugeKey('tenant-rg4', 'grace'))).toBe(0);
    });

    it('never throws — safeMetric swallow contract holds', () => {
      expect(() =>
        renewalsMetrics.pipelineRowCount('t', 'all', 9999),
      ).not.toThrow();
    });
  });
});
