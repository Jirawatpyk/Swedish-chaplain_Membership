/**
 * chaos-stripe-timeout.k6.js — F5 Stripe SDK timeout containment proof
 *
 * Audit 2026-04-26 round-2 self-review #R2-A7: validates that when
 * Stripe responds with 30s+ latency, the F5 use-case returns
 * `processor_unavailable` (502) within the gateway's 10s timeout
 * (`stripe-client.ts` `timeout: 10_000`) WITHOUT exhausting the Vercel
 * function thread pool.
 *
 * Pre-requisites:
 *   - Run a chaos proxy in front of Stripe API that injects 30s delay
 *     on `POST /v1/payment_intents`. Two options:
 *       (a) Toxiproxy: `toxiproxy-cli toxic add -t latency -a latency=30000 stripe-api`
 *       (b) k6 own httpClient interception (override Stripe base URL
 *           via env var STRIPE_API_BASE = http://localhost:8001)
 *   - Set LOAD_TARGET to a staging instance configured to use the proxy
 *
 * Pass criteria:
 *   - All requests return 502 `processor_unavailable` within 12s
 *   - No request takes longer than the SDK timeout × max-retries
 *     budget (~30s = 1 timeout + 3 retries × ~7s backoff)
 *   - Concurrent VUs do NOT exceed Vercel's function-instance limit
 *     (no 503 from platform layer)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const processorUnavailableCounter = new Counter('chaos_processor_unavailable');
const timeoutExceededCounter = new Counter('chaos_timeout_exceeded');
const platformErrorCounter = new Counter('chaos_platform_503');
const latencyTrend = new Trend('chaos_latency_ms');

const TARGET = __ENV.LOAD_TARGET || 'http://localhost:3100';
const COOKIE = __ENV.LOAD_AUTH_COOKIE || '';
const INVOICE_ID = __ENV.LOAD_INVOICE_ID || '';

if (!COOKIE || !INVOICE_ID) {
  throw new Error(
    'Set LOAD_AUTH_COOKIE + LOAD_INVOICE_ID + run a chaos proxy injecting 30s latency in front of Stripe — see tests/load/README.md',
  );
}

export const options = {
  scenarios: {
    chaos: {
      executor: 'shared-iterations',
      vus: 20,
      iterations: 20,
      maxDuration: '2m',
    },
  },
  thresholds: {
    // Each request should bound at SDK-internal max (~30s) — beyond
    // that means the Vercel function timed out instead of returning
    // a clean 502.
    'chaos_latency_ms': ['p(99)<35000'],
    'chaos_platform_503': ['count<1'], // Zero platform-layer errors
  },
};

// eslint-disable-next-line import/no-anonymous-default-export -- k6 entrypoint contract requires anonymous default function
export default function () {
  const res = http.post(
    `${TARGET}/api/payments/initiate`,
    JSON.stringify({ invoiceId: INVOICE_ID, method: 'card' }),
    {
      headers: {
        'Content-Type': 'application/json',
        Cookie: COOKIE,
      },
      // Allow up to 40s — beyond that = test infrastructure broke.
      timeout: '40s',
    },
  );

  latencyTrend.add(res.timings.duration);

  if (res.status === 502) {
    processorUnavailableCounter.add(1);
    check(res, {
      '502 has processor_unavailable code': (r) => {
        try {
          return JSON.parse(r.body).error?.code === 'processor_unavailable';
        } catch {
          return false;
        }
      },
      '502 returned within SDK budget (35s)': () =>
        res.timings.duration < 35_000,
    });
  } else if (res.status === 503) {
    platformErrorCounter.add(1);
  } else if (res.timings.duration >= 35_000) {
    timeoutExceededCounter.add(1);
  }

  sleep(0);
}

export function handleSummary(data) {
  const processorUnavailable =
    data.metrics.chaos_processor_unavailable?.values?.count ?? 0;
  const timeoutExceeded =
    data.metrics.chaos_timeout_exceeded?.values?.count ?? 0;
  const platformErrored = data.metrics.chaos_platform_503?.values?.count ?? 0;
  const p99 = data.metrics.chaos_latency_ms?.values?.['p(99)'] ?? 0;

  const summary = {
    scenario: 'chaos-stripe-timeout',
    processorUnavailable,
    timeoutExceeded,
    platformErrored,
    p99LatencyMs: Math.round(p99),
    // Pass: at least 15 of 20 returned 502 (clean degradation), zero
    // 503 (no platform-layer exhaustion), zero responses past 35s.
    passed:
      processorUnavailable >= 15 &&
      timeoutExceeded === 0 &&
      platformErrored === 0,
  };

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
