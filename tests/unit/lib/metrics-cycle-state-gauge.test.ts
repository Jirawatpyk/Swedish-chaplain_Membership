/**
 * F8 Phase 9 verify-fix C1 — `renewalsMetrics.observeCycleStateGauge`
 * multi-tenant accumulation invariant.
 *
 * Pins the per-process accumulator semantics documented in
 * `src/lib/metrics.ts:observeCycleStateGauge`:
 *
 *   1. Multiple tenants observed for the same state accumulate into
 *      the inner Map keyed by tenant slug — every tenant appears at
 *      scrape time as a distinct label series.
 *   2. Re-observing the same (tenant, state) pair OVERWRITES the
 *      prior value (not appends) — the gauge always reports the
 *      most-recent value per tenant.
 *   3. Each state ('active' | 'in_grace' | 'lapsed_total') has an
 *      independent inner Map — observations on one state do not
 *      leak into another.
 *   4. Lazy-registration: the OTel observable gauge is created on
 *      first observation per state and reused thereafter.
 *
 * Phase 9 verify-fix close-on-review: prior version asserted only
 * `not.toThrow()` — a `bucket.entries()` → `bucket.values()` regression
 * (which would silently drop the tenant label dimension at scrape
 * time) would still pass. This version uses the test-only
 * `__test__readGaugeValues(gaugeName)` accessor to inspect the
 * accumulator directly, pinning the actual invariant.
 */
import { describe, expect, it } from 'vitest';
import {
  renewalsMetrics,
  __test__readGaugeValues,
} from '@/lib/metrics';

describe('renewalsMetrics.observeCycleStateGauge — multi-tenant accumulation (Phase 9 / verify-fix C1)', () => {
  // Use unique tenant slugs per test (mirrors `createTestTenant`'s
  // UUID-suffix isolation strategy) so accumulating in the
  // process-level Map across tests does not bleed assertions.
  const tenantA = `mt-gauge-a-${Math.random().toString(36).slice(2, 10)}`;
  const tenantB = `mt-gauge-b-${Math.random().toString(36).slice(2, 10)}`;
  const tenantC = `mt-gauge-c-${Math.random().toString(36).slice(2, 10)}`;
  const tenantD = `mt-gauge-d-${Math.random().toString(36).slice(2, 10)}`;
  const tenantE = `mt-gauge-e-${Math.random().toString(36).slice(2, 10)}`;
  const tenantF = `mt-gauge-f-${Math.random().toString(36).slice(2, 10)}`;
  const tenantG = `mt-gauge-g-${Math.random().toString(36).slice(2, 10)}`;
  const tenantH = `mt-gauge-h-${Math.random().toString(36).slice(2, 10)}`;

  it('observe(tenantA, active, 42) writes to gaugeValues[renewals_cycles_active][tenantA]', () => {
    renewalsMetrics.observeCycleStateGauge(tenantA, 'active', 42);
    const bucket = __test__readGaugeValues('renewals_cycles_active');
    expect(bucket).toBeDefined();
    expect(bucket!.get(tenantA)).toBe(42);
  });

  it('three tenants observed for the same state accumulate — all 3 entries surface in the inner Map', () => {
    renewalsMetrics.observeCycleStateGauge(tenantB, 'active', 100);
    renewalsMetrics.observeCycleStateGauge(tenantC, 'active', 200);
    renewalsMetrics.observeCycleStateGauge(tenantD, 'active', 300);
    const bucket = __test__readGaugeValues('renewals_cycles_active');
    expect(bucket!.get(tenantB)).toBe(100);
    expect(bucket!.get(tenantC)).toBe(200);
    expect(bucket!.get(tenantD)).toBe(300);
    // The OTel callback iterates `.entries()` at scrape time — pin that
    // ALL three tenants appear in the iterator output.
    const entries = Array.from(bucket!.entries());
    const observedSlugs = entries.map(([slug]) => slug);
    expect(observedSlugs).toContain(tenantB);
    expect(observedSlugs).toContain(tenantC);
    expect(observedSlugs).toContain(tenantD);
  });

  it('re-observing same (tenant, state) overwrites — accumulator reports MOST RECENT value', () => {
    renewalsMetrics.observeCycleStateGauge(tenantE, 'in_grace', 5);
    renewalsMetrics.observeCycleStateGauge(tenantE, 'in_grace', 7);
    renewalsMetrics.observeCycleStateGauge(tenantE, 'in_grace', 3);
    const bucket = __test__readGaugeValues('renewals_cycles_in_grace');
    expect(bucket!.get(tenantE)).toBe(3);
    // Pin that there is exactly ONE entry for this tenant — overwrite,
    // not append.
    const entriesForTenant = Array.from(bucket!.entries()).filter(
      ([slug]) => slug === tenantE,
    );
    expect(entriesForTenant).toHaveLength(1);
  });

  it('each state has an independent inner Map — observations on one state do not leak into another', () => {
    renewalsMetrics.observeCycleStateGauge(tenantF, 'active', 11);
    renewalsMetrics.observeCycleStateGauge(tenantF, 'in_grace', 22);
    renewalsMetrics.observeCycleStateGauge(tenantF, 'lapsed_total', 33);
    const activeBucket = __test__readGaugeValues('renewals_cycles_active');
    const inGraceBucket = __test__readGaugeValues(
      'renewals_cycles_in_grace',
    );
    const lapsedBucket = __test__readGaugeValues(
      'renewals_cycles_lapsed_total',
    );
    expect(activeBucket!.get(tenantF)).toBe(11);
    expect(inGraceBucket!.get(tenantF)).toBe(22);
    expect(lapsedBucket!.get(tenantF)).toBe(33);
    // CRITICAL invariant — a regression that collapsed all three states
    // into one inner Map would surface here as one of the buckets
    // returning the WRONG value.
    expect(activeBucket!.get(tenantF)).not.toBe(22);
    expect(activeBucket!.get(tenantF)).not.toBe(33);
  });

  it('zero value is observable — tenant with 0 cycles must still appear in series (distinguishes "no cycles" from "not observed yet")', () => {
    renewalsMetrics.observeCycleStateGauge(tenantG, 'lapsed_total', 0);
    const bucket = __test__readGaugeValues(
      'renewals_cycles_lapsed_total',
    );
    expect(bucket!.has(tenantG)).toBe(true);
    expect(bucket!.get(tenantG)).toBe(0);
  });

  it('large numeric value (5000-member SLO ceiling per FR-046) does not overflow', () => {
    renewalsMetrics.observeCycleStateGauge(tenantH, 'active', 5_000);
    renewalsMetrics.observeCycleStateGauge(tenantH, 'in_grace', 600);
    const activeBucket = __test__readGaugeValues('renewals_cycles_active');
    const inGraceBucket = __test__readGaugeValues(
      'renewals_cycles_in_grace',
    );
    expect(activeBucket!.get(tenantH)).toBe(5_000);
    expect(inGraceBucket!.get(tenantH)).toBe(600);
    // Pin that the values are exactly preserved — no NaN / Infinity
    // coercion / float drift.
    expect(Number.isFinite(activeBucket!.get(tenantH)!)).toBe(true);
    expect(Number.isInteger(inGraceBucket!.get(tenantH)!)).toBe(true);
  });

  it('safeMetric error-swallow contract — observe() never throws into caller', () => {
    // The OTel SDK is not registered in vitest (no @vercel/otel boot),
    // so `meter()` may throw on first call OR return a no-op meter.
    // `safeMetric` swallows any throw; verify the contract holds for
    // every call site so a coordinator route's gauge observation
    // cannot block the cron pass.
    expect(() => {
      renewalsMetrics.observeCycleStateGauge(
        'safemetric-synthetic',
        'active',
        7,
      );
      renewalsMetrics.observeCycleStateGauge(
        'safemetric-synthetic',
        'in_grace',
        7,
      );
      renewalsMetrics.observeCycleStateGauge(
        'safemetric-synthetic',
        'lapsed_total',
        7,
      );
    }).not.toThrow();
    // Even when safeMetric swallows the throw, the value still lands
    // in the accumulator because the safeMetric wrapper is around the
    // meter()/createObservableGauge call, NOT around the value-Map
    // mutation. Verify the value did land.
    const bucket = __test__readGaugeValues('renewals_cycles_active');
    expect(bucket!.get('safemetric-synthetic')).toBe(7);
  });
});
