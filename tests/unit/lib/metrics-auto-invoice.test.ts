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
      method: 'observeAutoDraftQueueSizeGauge',
      gaugeName: 'renewals_auto_draft_queue_size',
      call: (t: string, v: number) =>
        renewalsMetrics.observeAutoDraftQueueSizeGauge(t, v),
    },
    {
      label: 'observeAutoDraftOldestAgeGauge',
      method: 'observeAutoDraftOldestAgeGauge',
      gaugeName: 'renewals_auto_draft_oldest_age_seconds',
      call: (t: string, v: number) =>
        renewalsMetrics.observeAutoDraftOldestAgeGauge(t, v),
    },
    {
      label: 'observeAwaitingPaymentNoInvoiceGauge',
      method: 'observeAwaitingPaymentNoInvoiceGauge',
      gaugeName: 'renewals_awaiting_payment_no_invoice',
      call: (t: string, v: number) =>
        renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(t, v),
    },
  ] as const;

  for (const { label, method, gaugeName, call } of gaugeCases) {
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

      // -------------------------------------------------------------------
      // Task 17 (Task 16 review MINOR-1) — the gauge REGISTRATION swallow.
      // -------------------------------------------------------------------
      //
      // `meterShouldThrow` arms `createObservableGauge`, but before this case
      // existed no gauge test ever set it — so the gauge half of the
      // `safeMetric` never-throw contract was asserted by nothing, while the
      // three counters had explicit coverage.
      //
      // `vi.resetModules()` is load-bearing, NOT ceremony. `observableGauges`
      // in metrics.ts is a module-level Map that is never cleared, so
      // `createObservableGauge` fires only on the FIRST observe of a given
      // name in a worker process. Every case above has already registered
      // these three names, so arming the meter and calling the statically
      // imported method would take the `if (!observableGauges.has(...))`
      // branch NOT taken, touch the meter zero times, and pass while
      // exercising nothing — the exact memoisation trap that made the counter
      // swallow tests vacuous twice (see the `meterShouldThrow` docstring).
      // A fresh module registry gives an empty instrument cache, so the
      // registration branch is genuinely re-entered.
      it('swallows a THROWING meter on the gauge REGISTRATION path', async () => {
        vi.resetModules();
        const fresh = await import('@/lib/metrics');
        meterShouldThrow = true;

        expect(() => fresh.renewalsMetrics[method](TENANT, 5)).not.toThrow();

        // The instrument was never registered, so nothing can be scraped.
        expect(observableGaugesCreated.has(gaugeName)).toBe(false);
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
  // observeAutoInvoiceGauges — all-or-nothing (Task 16 review MINOR-2)
  // -----------------------------------------------------------------------
  //
  // The three individual observe methods each swallow internally, so three
  // separate calls cannot report a partial emit failure to the cron route:
  // the route's catch only sees QUERY failures. A `createObservableGauge`
  // that threw on the second of three would leave gauge 1 fresh, gauge 2
  // absent and gauge 3 STALE at its previous value — and nothing about that
  // combination looks wrong on a dashboard. On
  // `renewals_awaiting_payment_no_invoice` a frozen `0` hides precisely the
  // wedged members the gauge exists to surface.
  describe('observeAutoInvoiceGauges (all-or-nothing)', () => {
    const VALUES = {
      queueSize: 4,
      oldestAgeSeconds: 900,
      awaitingPaymentNoInvoice: 2,
    } as const;

    it('observes all three and reports success', () => {
      expect(renewalsMetrics.observeAutoInvoiceGauges(TENANT, VALUES)).toBe(true);
      expect(__test__readGaugeValues('renewals_auto_draft_queue_size')?.get(TENANT)).toBe(4);
      expect(__test__readGaugeValues('renewals_auto_draft_oldest_age_seconds')?.get(TENANT)).toBe(900);
      expect(__test__readGaugeValues('renewals_awaiting_payment_no_invoice')?.get(TENANT)).toBe(2);
    });

    it('never throws even when the meter explodes — cron-path contract', () => {
      meterShouldThrow = true;
      expect(() =>
        renewalsMetrics.observeAutoInvoiceGauges(TENANT, VALUES),
      ).not.toThrow();
    });

    // THE assertion of this block: a failed emit must leave NO stale value
    // behind on ANY of the three, including ones written before the throw.
    it('rolls the whole tenant triple back to ABSENT when an emit fails', async () => {
      // Seed a previous successful pass, so there IS something to go stale.
      renewalsMetrics.observeAutoInvoiceGauges(TENANT, VALUES);
      expect(__test__readGaugeValues('renewals_awaiting_payment_no_invoice')?.get(TENANT)).toBe(2);

      // Fresh module registry so the registration branch is re-entered and
      // the armed meter is actually reached (same memoisation trap as the
      // MINOR-1 cases above) — but the accumulator is fresh too, so re-seed
      // it through the fresh module first.
      vi.resetModules();
      const fresh = await import('@/lib/metrics');
      fresh.renewalsMetrics.observeAutoInvoiceGauges(TENANT, VALUES);
      expect(
        fresh.__test__readGaugeValues('renewals_awaiting_payment_no_invoice')?.get(TENANT),
      ).toBe(2);

      meterShouldThrow = true;
      vi.resetModules();
      const fresher = await import('@/lib/metrics');
      // Carry a stale value into the fresher registry, then fail an emit.
      fresher.renewalsMetrics.observeAwaitingPaymentNoInvoiceGauge(TENANT, 2);
      const okAfter = fresher.renewalsMetrics.observeAutoInvoiceGauges(TENANT, {
        queueSize: 9,
        oldestAgeSeconds: 9,
        awaitingPaymentNoInvoice: 9,
      });

      expect(okAfter).toBe(false);
      // Absent — not 2 (stale) and not 9 (half-written).
      for (const name of [
        'renewals_auto_draft_queue_size',
        'renewals_auto_draft_oldest_age_seconds',
        'renewals_awaiting_payment_no_invoice',
      ]) {
        expect(fresher.__test__readGaugeValues(name)?.get(TENANT)).toBeUndefined();
      }
    });

    // NO peer-tenant-on-failure case here, deliberately.
    //
    // An earlier draft of this block had one ("observe tenant B, arm the
    // meter, observe tenant A, assert B survives"). It passed — and tested
    // nothing. Probed by asserting the call reported failure: it returned
    // `true`. Reachability analysis explains why, and the conclusion
    // generalises beyond the test:
    //
    //   Inside `observeTenantGaugeOrThrow` the only statements that can throw
    //   are `createObservableGauge` / `addCallback`, both guarded by
    //   `if (!observableGauges.has(name))`. The Map writes cannot throw. So
    //   once a gauge name is registered in a process, observing it again is
    //   infallible — and all three names register together on the first
    //   `observeAutoInvoiceGauges` call, because that is the only caller in
    //   the cron route.
    //
    // Therefore a failure can only occur on the FIRST call in a process, at
    // which point no peer tenant has values to protect: the coordinator's
    // `Promise.allSettled` fan-out means whichever tenant goes first is the
    // one that registers, and a later tenant simply retries any registration
    // the first left undone. There is no reachable state where tenant A's
    // failure could touch tenant B's values.
    //
    // The rollback primitive's per-tenant scoping IS still asserted — see
    // "does NOT disturb another tenant" in the `forgetAutoInvoiceGauges`
    // block above, where it is reachable directly. Writing an unreachable
    // scenario here would have added a fifth always-green test to a file
    // whose header already documents three such incidents.
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
