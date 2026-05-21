/**
 * T122 — F7.1a Email Broadcast Advanced OpenTelemetry metrics.
 *
 * Sibling-namespace to `src/lib/metrics.ts` `broadcastsMetrics` aggregate.
 * F7.1a-specific instruments live here so the F7 MVP catalogue in
 * `src/lib/metrics.ts` stays focused on shipped surfaces and reviewers
 * can map alert rules in `docs/observability.md § 22.2 (F7.1a)` to a
 * single file.
 *
 * Module-resolution note: `from '@/lib/metrics'` still resolves to
 * `src/lib/metrics.ts` (file resolves before directory). New F7.1a
 * call sites use the explicit `from '@/lib/metrics/broadcasts-f71a'`
 * import path.
 *
 * Five instruments per plan.md § VII (F7.1a) + tasks.md T122:
 *   - `broadcasts.batch_dispatch_duration_ms{tenant,batch_index}` — histogram
 *   - `broadcasts.partial_send_count{tenant}` — counter
 *   - `broadcasts.manual_retry_count{tenant,broadcast_id}` — counter
 *   - `broadcasts.image_scan_duration_ms{tenant,verdict}` — histogram
 *   - `broadcasts.clamav_signature_age_hours{}` — observable gauge
 *
 * Cardinality discipline (Constitution VII):
 *   - `tenant` ∈ small-cardinality slug set (≤ a few hundred lifetime).
 *   - `batch_index` ∈ 0..K where K ≤ ceil(50000 / 10000) = 5 (US1 ceiling).
 *   - `verdict` ∈ {clean, infected, error, timeout} — bounded enum.
 *   - `broadcast_id` is intentionally accepted as a label per tasks.md
 *     T122 wording. Cardinality risk noted: ~broadcasts/day × retention
 *     can grow large. Mitigation: this counter is used for ad-hoc
 *     forensic queries (per-broadcast retry history), NOT for SLO
 *     alerting — alert rules pivot on `partial_send_count{tenant}` and
 *     `dispatch_budget_exhausted` instead. If cardinality concerns
 *     escalate (>10k broadcast_id values per tenant per scrape window),
 *     downgrade to `tenant`-only and surface broadcast_id via trace
 *     span attribute instead.
 *
 * Alert thresholds (T123 wires them into `docs/observability.md § 22.10`):
 *   - `clamav_signature_age_hours > 48` → critical (signatures stale).
 *   - ClamAV daemon down → proxied via `broadcasts_image_scan_duration_ms`
 *     p99 > 5000ms over 5 min OR no scan completes in 2 min when uploads
 *     are attempted. Direct `clamav_daemon_unreachable` counter NOT
 *     emitted by this module — the proxy is sufficient because every
 *     real-world daemon-down condition manifests as a scan-latency or
 *     scan-absence signal (decision documented at review-finding
 *     comment-analyzer M-2 closure 2026-05-21). A dedicated counter
 *     would require a separate connectivity-probe cron and a tx-bound
 *     emit — both YAGNI for F7.1a per Constitution X.
 *   - `partial_send_count[1h] / broadcasts.submit.count[1h] > 0.05` → warn.
 *   - `dispatch_concurrency_saturation > 0.8` → warn (computed from
 *     active-batch count vs concurrency cap; gauge derived at the
 *     dispatcher rather than emitted by this module).
 *
 * Test discipline: mock via `vi.mock('@/lib/metrics/broadcasts-f71a')`
 * — module path is stable across F7.1a + F7.1b.
 */
import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from '@opentelemetry/api';

const METER_NAME = 'swecham.platform';

let cachedMeter: Meter | null = null;
function meter(): Meter {
  if (!cachedMeter) {
    cachedMeter = metrics.getMeter(METER_NAME, '1.0.0');
  }
  return cachedMeter;
}

// --- Instrument cache --------------------------------------------------------
//
// Local caches mirror the `src/lib/metrics.ts` pattern. Keeping them
// scoped to this file (rather than re-using `metrics.ts`'s caches) is
// intentional — first because the existing caches are not exported, and
// second because module-level state isolation lets us reason about
// F7.1a memory footprint independently. Cache size is small (≤5 entries
// per type) so duplication is cheap.

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();
const observableGauges = new Map<string, ObservableGauge>();
const gaugeValues = new Map<string, Map<string, number>>();

function counter(name: string, description: string): Counter {
  let instr = counters.get(name);
  if (!instr) {
    instr = meter().createCounter(name, { description });
    counters.set(name, instr);
  }
  return instr;
}

function histogram(name: string, description: string, unit: string): Histogram {
  let instr = histograms.get(name);
  if (!instr) {
    instr = meter().createHistogram(name, { description, unit });
    histograms.set(name, instr);
  }
  return instr;
}

/**
 * Observe a value for an async gauge keyed by an arbitrary label set.
 * Mirrors the `observeGauge` helper in `src/lib/metrics.ts` — same
 * stable-serialisation pattern (sorted keys → JSON-stringify) so the
 * inner-map key set converges across scrape windows.
 */
function observeGauge(
  name: string,
  description: string,
  labels: Record<string, string>,
  value: number,
): void {
  let perLabel = gaugeValues.get(name);
  if (!perLabel) {
    perLabel = new Map<string, number>();
    gaugeValues.set(name, perLabel);
  }
  const labelKey = JSON.stringify(
    Object.fromEntries(
      Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  perLabel.set(labelKey, value);

  if (!observableGauges.has(name)) {
    const gauge = meter().createObservableGauge(name, { description });
    gauge.addCallback((observer) => {
      const current = gaugeValues.get(name);
      if (!current) return;
      for (const [k, v] of current) {
        try {
          const parsed = JSON.parse(k) as Record<string, string>;
          observer.observe(v, parsed);
        } catch {
          // ignore malformed key
        }
      }
    });
    observableGauges.set(name, gauge);
  }
}

/**
 * Swallow OTel emission failures. Mirrors the `safeMetric` helper in
 * `src/lib/metrics.ts`. The F7.1a dispatch / image-upload surfaces are
 * member-facing — signal loss is preferable to a 500 if the OTel
 * pipeline throws on first record.
 */
function safeMetric(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn('metrics_emit_failed_swallowed', {
      err: (e as Error).message,
      surface: 'broadcasts_f71a',
    });
  }
}

// --- Public API --------------------------------------------------------------

/**
 * Scan-verdict alphabet for `broadcasts.image_scan_duration_ms{verdict}`.
 * Shared with `validate-image-source-allowlist` + `scan-inline-image-for-virus`
 * use-cases.
 */
export type ImageScanVerdict = 'clean' | 'infected' | 'error' | 'timeout';

export const broadcastsF71aMetrics = {
  /**
   * `broadcasts.batch_dispatch_duration_ms{tenant,batch_index}` — per-batch
   * dispatch latency histogram. Recorded once per successful batch (split →
   * Resend submit → audience-bind → confirm). SLO context per plan.md:
   * SC-001 (10k recipients ≤ 10 min E2E) implies per-batch budget ~60s; an
   * SLO of `p95 batch_dispatch_duration_ms < 90000` (90s) is the F7.1a
   * dispatch-budget guard-rail. Alert on p95 > 90s sustained for 15 min.
   */
  batchDispatchDurationMs(
    tenantId: string,
    batchIndex: number,
    ms: number,
  ): void {
    safeMetric(() => {
      histogram(
        'broadcasts_batch_dispatch_duration_ms',
        'F7.1a US1 — per-batch dispatch latency (split → submit → bind → confirm)',
        'ms',
      ).record(ms, {
        tenant: tenantId,
        batch_index: String(batchIndex),
      });
    });
  },

  /**
   * `broadcasts.partial_send_count{tenant}` — counter incremented when a
   * broadcast transitions to `partially_sent` (some batches landed, others
   * failed after retry budget exhausted). Alert: rate /
   * `submit_count[1h] > 5%` → warn (partial-send normalises slow but
   * recovers within F7.1a's 3-retry retry policy). Steady non-zero
   * baseline acceptable; sustained spike indicates Resend-side outage.
   */
  partialSendCount(tenantId: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_partial_send_count',
        'F7.1a US1 — broadcasts that landed in partially_sent terminal state',
      ).add(1, { tenant: tenantId });
    });
  },

  /**
   * `broadcasts.manual_retry_count{tenant,broadcast_id}` — counter
   * incremented when an admin invokes "retry failed batches" on a
   * `partially_sent` broadcast. Per FR-008d the 3-retry budget is
   * per-broadcast — this counter surfaces ad-hoc forensics ("which
   * broadcast was retried how many times?").
   *
   * Cardinality: `broadcast_id` is intentionally per-spec (T122). See
   * file-header cardinality discipline note for the SLO-vs-forensic
   * tradeoff.
   */
  manualRetryCount(tenantId: string, broadcastId: string): void {
    safeMetric(() => {
      counter(
        'broadcasts_manual_retry_count',
        'F7.1a US1 — admin-initiated retries of failed batches per broadcast',
      ).add(1, {
        tenant: tenantId,
        broadcast_id: broadcastId,
      });
    });
  },

  /**
   * `broadcasts.image_scan_duration_ms{tenant,verdict}` — ClamAV scan
   * latency histogram. SLO-F7.1a-SC-005: ≤500ms p95 for files ≤2 MB.
   * `verdict` distinguishes the four terminal scan outcomes — slow
   * `timeout` verdicts indicate Fly.io VM CPU saturation; slow `clean`
   * verdicts indicate signature DB growth or large-file outliers.
   *
   * Alert: `p95 > 500` sustained 15 min → warn (SLO violation);
   * `p99 > 5000` (5s) → critical (scan-pipeline saturation).
   */
  imageScanDurationMs(
    tenantId: string,
    verdict: ImageScanVerdict,
    ms: number,
  ): void {
    safeMetric(() => {
      histogram(
        'broadcasts_image_scan_duration_ms',
        'F7.1a US2 — ClamAV inline-image scan latency by verdict (SC-005 p95 < 500ms)',
        'ms',
      ).record(ms, {
        tenant: tenantId,
        verdict,
      });
    });
  },

  /**
   * `broadcasts.clamav_signature_age_hours{}` — observable gauge surfacing
   * the age of the most-recently-loaded ClamAV signature database. Probed
   * via `CLAMD VERSION` socket call (returns `ClamAV 1.x.y/<sig_version>/<build_time>`).
   * The age delta is computed by `scripts/probe-clamav-signature-age.ts`
   * (registered cron-job.org coordinator, hourly cadence) — that script
   * calls this method with the computed `ageHours`.
   *
   * Alert: `clamav_signature_age_hours > 48` → critical (freshclam
   * stopped pulling). Runbook: `docs/runbooks/clamav-signature-stale.md`.
   *
   * No `tenant` label — ClamAV is a shared cross-tenant infrastructure
   * service (single Fly.io VM per region).
   */
  clamavSignatureAgeHours(ageHours: number): void {
    safeMetric(() => {
      observeGauge(
        'broadcasts_clamav_signature_age_hours',
        'F7.1a US2 — Age of most-recent ClamAV signature DB load (alert > 48h)',
        {},
        ageHours,
      );
    });
  },
} as const;

// --- Test-only accessor (mirrors src/lib/metrics.ts pattern) ----------------

/**
 * Test-only accessor for the gauge-values accumulator. Lets unit tests
 * pin the multi-tenant accumulation invariant for the F7.1a observable
 * gauge (`broadcasts_clamav_signature_age_hours`). Returns the inner
 * Map for the requested gauge name (READ-ONLY — mutation would corrupt
 * production state in the same process).
 *
 * M-4 fix 2026-05-21 (review finding code-reviewer-narrow H-1 +
 * code-reviewer-full M-4): named distinctly from
 * `src/lib/metrics.ts:__test__readGaugeValues` (the F7 MVP module-
 * scoped accessor) so a test that imports from the wrong module gets
 * a TypeScript "missing export" error rather than silently reading
 * the OTHER module's gauge accumulator. The two modules back
 * INDEPENDENT `gaugeValues` Maps — collision would produce false-GREEN
 * tests where a gauge observed on the F7.1a module wouldn't be visible
 * via the F7 MVP accessor and vice versa.
 */
export function __test__readF71aGaugeValues(
  gaugeName: string,
): ReadonlyMap<string, number> | undefined {
  return gaugeValues.get(gaugeName);
}
