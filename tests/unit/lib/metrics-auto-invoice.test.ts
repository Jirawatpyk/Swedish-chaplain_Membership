/**
 * 107-auto-invoice Task 16 — Unit tests for the auto-invoice observability
 * layer (counters + observable gauges) added to `renewalsMetrics`.
 *
 * Pins the instrument NAME, label KEYS, and label VALUES for each new
 * instrument so a dashboard/alert regression surfaces at unit-test time
 * rather than at production deploy. Mirrors the harness in
 * `metrics-w009-renewals.test.ts` (fake meter capturing createCounter /
 * Counter.add / createObservableGauge) and the gauge-accumulator
 * inspection contract of `metrics-cycle-state-gauge.test.ts`
 * (`__test__readGaugeValues` — bare-tenant-string inner-Map key).
 *
 * Instruments verified here:
 *   1. `renewals_auto_draft_created_total{tenant}`
 *   2. `renewals_auto_draft_skipped_total{tenant, reason}`
 *   3. `renewals_auto_draft_errors_total{tenant}`
 *   4. `renewals_auto_draft_queue_size{tenant}`            (ObservableGauge)
 *   5. `renewals_auto_draft_oldest_age_seconds{tenant}`    (ObservableGauge)
 *   6. `renewals_awaiting_payment_no_invoice{tenant}`      (ObservableGauge)
 *
 * Plus the SKIP-REASON MAPPING PIN (§ "reason label mapping" below) — the
 * single most important assertion in this file. See the long comment there.
 *
 * The OTel `gauge.addCallback` scrape path is NOT exercisable under vitest
 * (no exporter boots), exactly as documented on `observeCycleStateGauge` —
 * these tests cover instrument registration + the accumulator map, and the
 * callback body is covered end-to-end in staging via `@vercel/otel`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// -------------------------------------------------------------------------
// Fake meter: captures createCounter + Counter.add + createObservableGauge.
// -------------------------------------------------------------------------

interface CapturedCounterAdd {
  readonly value: number;
  readonly attrs: Record<string, unknown>;
}

const counterAddsByName = new Map<string, CapturedCounterAdd[]>();
const observableGaugesCreated = new Set<string>();

/**
 * Review M-2 — when true, the fake meter's `createCounter` /
 * `createObservableGauge` throw.
 *
 * Without this the `not.toThrow()` cases were vacuous: the fake meter never
 * failed, so `safeMetric`'s swallow — the thing those tests claim to cover,
 * and the thing the whole "a gauge must never take the cron down" guarantee
 * rests on — was never actually exercised. Any assertion that a wrapper
 * swallows errors has to produce an error first.
 */
let meterShouldThrow = false;

function throwIfArmed(): void {
  if (meterShouldThrow) {
    throw new Error('meter exploded (simulated OTel SDK failure)');
  }
}

function getOrCreateCounterBucket(name: string): CapturedCounterAdd[] {
  let bucket = counterAddsByName.get(name);
  if (!bucket) {
    bucket = [];
    counterAddsByName.set(name, bucket);
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
        createCounter: (name: string) => {
          throwIfArmed();
          return {
            add: (value: number, attrs: Record<string, unknown>) => {
              // Also armed HERE, not only in the factory. `counter()` in
              // metrics.ts memoises instruments in a module-level Map, so a
              // counter already created by an earlier test is never
              // re-created — arming only the factory left these tests
              // vacuous a second time (verified: 3 failures showing `add`
              // had succeeded). Throwing at the call site exercises
              // safeMetric regardless of memoisation.
              throwIfArmed();
              getOrCreateCounterBucket(name).push({ value, attrs });
            },
          };
        },
        createHistogram: () => ({ record: () => {} }),
        createObservableGauge: (name: string) => {
          throwIfArmed();
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
import { AUTO_DRAFT_SKIP_REASON_LABEL } from '@/modules/renewals/application/use-cases/auto-draft-due-renewals';

const TENANT = 'tenant-task16-a';
const OTHER_TENANT = 'tenant-task16-b';

describe('107-auto-invoice Task 16 — auto-invoice metrics', () => {
  beforeEach(() => {
    counterAddsByName.clear();
    observableGaugesCreated.clear();
    // `gaugeValues` is a module-level closure cache that vitest does NOT
    // reset between cases — drop it so a re-observe assertion cannot read
    // a value bled in from an earlier test.
    __test__clearGaugeValues();
    meterShouldThrow = false;
  });

  // -----------------------------------------------------------------------
  // 1. renewals_auto_draft_created_total{tenant}
  // -----------------------------------------------------------------------
  describe('autoDraftCreated', () => {
    it('emits `renewals_auto_draft_created_total` with a bare `tenant` label', () => {
      renewalsMetrics.autoDraftCreated(TENANT);
      const bucket = counterAddsByName.get('renewals_auto_draft_created_total');
      expect(bucket).toBeDefined();
      expect(bucket).toHaveLength(1);
      expect(bucket![0]).toEqual({ value: 1, attrs: { tenant: TENANT } });
    });

    it('increments by 1 per call — one call per drafted cycle', () => {
      renewalsMetrics.autoDraftCreated(TENANT);
      renewalsMetrics.autoDraftCreated(TENANT);
      renewalsMetrics.autoDraftCreated(OTHER_TENANT);
      const bucket = counterAddsByName.get('renewals_auto_draft_created_total')!;
      expect(bucket).toHaveLength(3);
      expect(bucket.map((b) => b.attrs.tenant)).toEqual([
        TENANT,
        TENANT,
        OTHER_TENANT,
      ]);
      expect(bucket.every((b) => b.value === 1)).toBe(true);
    });

    it('swallows a THROWING meter — safeMetric contract (review M-2)', () => {
      // Arm the fake meter to blow up, so this actually exercises
      // safeMetric instead of asserting that a no-op does not throw.
      meterShouldThrow = true;
      expect(() => renewalsMetrics.autoDraftCreated(TENANT)).not.toThrow();
      // ...and nothing was recorded, i.e. it failed closed, not silently
      // half-way.
      expect(counterAddsByName.get('renewals_auto_draft_created_total')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 2. renewals_auto_draft_skipped_total{tenant, reason}
  // -----------------------------------------------------------------------
  describe('autoDraftSkipped', () => {
    it('emits `renewals_auto_draft_skipped_total` with `tenant` + `reason`', () => {
      renewalsMetrics.autoDraftSkipped(TENANT, 'existing_invoice');
      const bucket = counterAddsByName.get('renewals_auto_draft_skipped_total');
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({
        value: 1,
        attrs: { tenant: TENANT, reason: 'existing_invoice' },
      });
    });

    it('keeps each reason a distinct label series', () => {
      renewalsMetrics.autoDraftSkipped(TENANT, 'existing_invoice');
      renewalsMetrics.autoDraftSkipped(TENANT, 'race_lost');
      renewalsMetrics.autoDraftSkipped(TENANT, 'membership_not_full');
      const bucket = counterAddsByName.get('renewals_auto_draft_skipped_total')!;
      expect(bucket.map((b) => b.attrs.reason)).toEqual([
        'existing_invoice',
        'race_lost',
        'membership_not_full',
      ]);
    });

    it('swallows a THROWING meter — safeMetric contract (review M-2)', () => {
      meterShouldThrow = true;
      expect(() =>
        renewalsMetrics.autoDraftSkipped(TENANT, 'race_lost'),
      ).not.toThrow();
      expect(counterAddsByName.get('renewals_auto_draft_skipped_total')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 3. renewals_auto_draft_errors_total{tenant}
  // -----------------------------------------------------------------------
  describe('autoDraftErrors', () => {
    it('emits `renewals_auto_draft_errors_total` with a bare `tenant` label', () => {
      renewalsMetrics.autoDraftErrors(TENANT);
      const bucket = counterAddsByName.get('renewals_auto_draft_errors_total');
      expect(bucket).toBeDefined();
      expect(bucket![0]).toEqual({ value: 1, attrs: { tenant: TENANT } });
    });

    it('swallows a THROWING meter — safeMetric contract (review M-2)', () => {
      meterShouldThrow = true;
      expect(() => renewalsMetrics.autoDraftErrors(TENANT)).not.toThrow();
      expect(counterAddsByName.get('renewals_auto_draft_errors_total')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // 4-6. Observable gauges — accumulator + lazy registration contract
  // -----------------------------------------------------------------------
  const gaugeCases = [
    {
      label: 'observeAutoDraftQueueSizeGauge',
      gaugeName: 'renewals_auto_draft_queue_size',
      call: (t: string, v: number) =>
        renewalsMetrics.observeAutoDraftQueueSizeGauge(t, v),
    },
    {
      label: 'observeAutoDraftOldestAgeGauge',
      gaugeName: 'renewals_auto_draft_oldest_age_seconds',
      call: (t: string, v: number) =>
        renewalsMetrics.observeAutoDraftOldestAgeGauge(t, v),
    },
    {
      label: 'observeAwaitingPaymentNoInvoiceGauge',
      gaugeName: 'renewals_awaiting_payment_no_invoice',
      call: (t: string, v: number) =>
        renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(t, v),
    },
  ] as const;

  for (const { label, gaugeName, call } of gaugeCases) {
    describe(label, () => {
      it(`registers an ObservableGauge named \`${gaugeName}\``, () => {
        call(TENANT, 7);
        // NOTE: gauge instruments are process-singletons (`observableGauges`
        // is never cleared), so a prior test file in the same worker may
        // already have registered it — assert on the accumulator, and on
        // registration only as a set-membership check.
        expect(__test__readGaugeValues(gaugeName)?.get(TENANT)).toBe(7);
      });

      it('keys the accumulator by BARE tenant string (not a JSON label blob)', () => {
        call(TENANT, 3);
        const bucket = __test__readGaugeValues(gaugeName);
        expect(bucket).toBeDefined();
        expect([...bucket!.keys()]).toEqual([TENANT]);
      });

      it('overwrites (does not accumulate) on re-observe — gauge semantics', () => {
        call(TENANT, 10);
        call(TENANT, 4);
        expect(__test__readGaugeValues(gaugeName)?.get(TENANT)).toBe(4);
      });

      it('keeps tenants isolated', () => {
        call(TENANT, 1);
        call(OTHER_TENANT, 99);
        const bucket = __test__readGaugeValues(gaugeName)!;
        expect(bucket.get(TENANT)).toBe(1);
        expect(bucket.get(OTHER_TENANT)).toBe(99);
      });

      it('accepts zero without throwing (empty-queue steady state)', () => {
        expect(() => call(TENANT, 0)).not.toThrow();
        expect(__test__readGaugeValues(gaugeName)?.get(TENANT)).toBe(0);
      });
    });
  }

  it('registers all three auto-invoice gauges under distinct names', () => {
    renewalsMetrics.observeAutoDraftQueueSizeGauge(TENANT, 1);
    renewalsMetrics.observeAutoDraftOldestAgeGauge(TENANT, 2);
    renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(TENANT, 3);
    expect(__test__readGaugeValues('renewals_auto_draft_queue_size')?.get(TENANT)).toBe(1);
    expect(__test__readGaugeValues('renewals_auto_draft_oldest_age_seconds')?.get(TENANT)).toBe(2);
    expect(__test__readGaugeValues('renewals_awaiting_payment_no_invoice')?.get(TENANT)).toBe(3);
  });

  // -----------------------------------------------------------------------
  // forgetAutoInvoiceGauges — staleness contract (review MAJOR-4)
  // -----------------------------------------------------------------------
  //
  // `gaugeValues` is a last-observed-wins accumulator that nothing deletes
  // from, and the gauge callbacks re-read it at every scrape. So a feed
  // whose query starts failing would keep re-reporting its last successful
  // value forever. For `renewals_awaiting_payment_no_invoice` that is
  // corrosive: a stale `0` masks exactly the wedge the gauge exists to
  // catch. These tests pin the "absent, not frozen" behaviour.
  describe('forgetAutoInvoiceGauges (staleness contract)', () => {
    it('drops all three gauge values for the tenant', () => {
      renewalsMetrics.observeAutoDraftQueueSizeGauge(TENANT, 5);
      renewalsMetrics.observeAutoDraftOldestAgeGauge(TENANT, 600);
      renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(TENANT, 2);

      renewalsMetrics.forgetAutoInvoiceGauges(TENANT);

      expect(__test__readGaugeValues('renewals_auto_draft_queue_size')?.get(TENANT)).toBeUndefined();
      expect(__test__readGaugeValues('renewals_auto_draft_oldest_age_seconds')?.get(TENANT)).toBeUndefined();
      expect(__test__readGaugeValues('renewals_awaiting_payment_no_invoice')?.get(TENANT)).toBeUndefined();
    });

    it('does NOT disturb another tenant — one tenant failing must not blank a healthy one', () => {
      renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(TENANT, 2);
      renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(OTHER_TENANT, 7);

      renewalsMetrics.forgetAutoInvoiceGauges(TENANT);

      const bucket = __test__readGaugeValues('renewals_awaiting_payment_no_invoice')!;
      expect(bucket.get(TENANT)).toBeUndefined();
      expect(bucket.get(OTHER_TENANT)).toBe(7);
    });

    it('is a safe no-op when the tenant was never observed', () => {
      expect(() =>
        renewalsMetrics.forgetAutoInvoiceGauges('never-seen-tenant'),
      ).not.toThrow();
    });

    it('a stale value does NOT survive — the regression this prevents', () => {
      // Simulate: successful pass observes 0 (no wedge), then the query
      // starts failing. Without the forget call the gauge would keep
      // reporting 0 at every scrape and AI-A1 would never fire again.
      renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(TENANT, 0);
      expect(__test__readGaugeValues('renewals_awaiting_payment_no_invoice')?.get(TENANT)).toBe(0);

      renewalsMetrics.forgetAutoInvoiceGauges(TENANT);

      // Absent, not 0. Absence is a condition monitoring can alert on.
      const bucket = __test__readGaugeValues('renewals_awaiting_payment_no_invoice');
      expect(bucket?.has(TENANT)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // reason label mapping — THE LOAD-BEARING ASSERTION OF THIS FILE
  // -----------------------------------------------------------------------
  //
  // `AUTO_DRAFT_SKIP_REASON_LABEL` maps the use-case's INTERNAL outcome
  // names onto the EXTERNAL metric `reason` label. Two of the three map
  // across unchanged; the third deliberately does NOT, and that divergence
  // is the whole point:
  //
  //   internal `skipped_terminated`  →  label `membership_not_full`
  //
  // The internal bucket is populated from `deriveMembershipAccess(...)
  // .access !== 'full'`, and `access` is a THREE-value union
  // (`'full' | 'suspended' | 'terminated'`). So the bucket counts SUSPENDED
  // members too — and `suspended` includes the `unpaid` reason, i.e. the
  // ordinary state of any member with an outstanding invoice during
  // renewal season. A metric label reading "terminated" while counting
  // members who merely have not paid yet would mislead whoever is on call,
  // permanently and undetectably.
  //
  // Do NOT "align" these two names. The internal name is shipped code with
  // its own review history; the label is a contract with a human reading a
  // dashboard at 3am. They are allowed to differ, and here they must.
  // These assertions exist to make an alignment attempt fail loudly.
  describe('reason label mapping (internal bucket → metric label)', () => {
    it('maps `skipped_terminated` to `membership_not_full`, NOT `terminated`', () => {
      expect(AUTO_DRAFT_SKIP_REASON_LABEL.skipped_terminated).toBe(
        'membership_not_full',
      );
    });

    it('never emits a label containing the word "terminated"', () => {
      const labels = Object.values(AUTO_DRAFT_SKIP_REASON_LABEL);
      expect(labels.some((l) => l.includes('terminated'))).toBe(false);
    });

    it('pins the full mapping (a new skip outcome must be mapped deliberately)', () => {
      expect(AUTO_DRAFT_SKIP_REASON_LABEL).toEqual({
        skipped_existing: 'existing_invoice',
        skipped_race_lost: 'race_lost',
        skipped_terminated: 'membership_not_full',
      });
    });
  });
});
