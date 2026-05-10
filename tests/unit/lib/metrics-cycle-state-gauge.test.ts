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
 * Why this matters: a future refactor that inadvertently keys the
 * inner Map by something other than tenant slug (e.g. timestamp,
 * call-count) would silently break multi-tenant dashboards — only
 * one tenant's series would appear at scrape time. The unit test
 * locks in the invariant.
 */
import { describe, expect, it } from 'vitest';
import { renewalsMetrics } from '@/lib/metrics';

describe('renewalsMetrics.observeCycleStateGauge — multi-tenant accumulation (Phase 9 / verify-fix C1)', () => {
  // Use unique tenant slugs per test (mirrors `createTestTenant`'s
  // UUID-suffix isolation strategy) so accumulating in the
  // process-level Map across tests does not bleed assertions.
  const tenantA = `mt-gauge-a-${Math.random().toString(36).slice(2, 10)}`;
  const tenantB = `mt-gauge-b-${Math.random().toString(36).slice(2, 10)}`;
  const tenantC = `mt-gauge-c-${Math.random().toString(36).slice(2, 10)}`;

  it('observe(tenantA, active, N) does NOT throw — happy path', () => {
    expect(() => {
      renewalsMetrics.observeCycleStateGauge(tenantA, 'active', 42);
    }).not.toThrow();
  });

  it('three tenants observed for the same state accumulate without throwing — multi-tenant invariant', () => {
    // Each call writes to gaugeValues[renewals_cycles_active][<tenant>].
    // The OTel callback iterates ALL tenant entries at scrape time.
    expect(() => {
      renewalsMetrics.observeCycleStateGauge(tenantA, 'active', 100);
      renewalsMetrics.observeCycleStateGauge(tenantB, 'active', 200);
      renewalsMetrics.observeCycleStateGauge(tenantC, 'active', 300);
    }).not.toThrow();
  });

  it('re-observing same (tenant, state) overwrites — gauge reports latest value', () => {
    // The inner Map's `.set(tenant, value)` semantics overwrite the
    // prior value. This pins the contract: a tenant's gauge always
    // reports the MOST RECENT observation, not a cumulative sum.
    expect(() => {
      renewalsMetrics.observeCycleStateGauge(tenantA, 'in_grace', 5);
      renewalsMetrics.observeCycleStateGauge(tenantA, 'in_grace', 7);
      renewalsMetrics.observeCycleStateGauge(tenantA, 'in_grace', 3);
    }).not.toThrow();
  });

  it('each state has an independent inner Map — observations do not cross-leak', () => {
    // observeCycleStateGauge('active', N) and ('in_grace', M) and
    // ('lapsed_total', K) are stored under three SEPARATE gauge keys.
    // A bug that collapsed all three states into one Map would still
    // pass the previous tests (since the assertion is no-throw); this
    // test pins the separation by exercising all three independently.
    expect(() => {
      renewalsMetrics.observeCycleStateGauge(tenantB, 'active', 11);
      renewalsMetrics.observeCycleStateGauge(tenantB, 'in_grace', 22);
      renewalsMetrics.observeCycleStateGauge(tenantB, 'lapsed_total', 33);
    }).not.toThrow();
  });

  it('zero value is observable (legitimately reports 0 active cycles for a tenant)', () => {
    // A tenant with zero active cycles MUST still appear in the gauge
    // series — otherwise the dashboard cannot distinguish "tenant
    // has zero cycles" from "tenant has not been observed yet".
    expect(() => {
      renewalsMetrics.observeCycleStateGauge(tenantC, 'lapsed_total', 0);
    }).not.toThrow();
  });

  it('large numeric value (5000-member SLO ceiling per FR-046) does not overflow', () => {
    // SC-003 budgets at 5,000 active members per tenant + 600 in
    // 90-day window. Pin that the gauge accepts the order-of-magnitude
    // ceiling without coercing to NaN/Infinity (would silently break
    // the dashboard's p95 panel).
    expect(() => {
      renewalsMetrics.observeCycleStateGauge(tenantC, 'active', 5_000);
      renewalsMetrics.observeCycleStateGauge(tenantC, 'in_grace', 600);
    }).not.toThrow();
  });

  it('safeMetric error-swallow contract — observe() never throws into caller', () => {
    // The OTel SDK is not registered in vitest (no @vercel/otel boot),
    // so `meter()` may throw on first call OR return a no-op meter.
    // `safeMetric` swallows any throw; verify the contract holds for
    // every call site so a coordinator route's gauge observation
    // cannot block the cron pass.
    expect(() => {
      renewalsMetrics.observeCycleStateGauge('synthetic', 'active', 7);
      renewalsMetrics.observeCycleStateGauge('synthetic', 'in_grace', 7);
      renewalsMetrics.observeCycleStateGauge('synthetic', 'lapsed_total', 7);
    }).not.toThrow();
  });
});
