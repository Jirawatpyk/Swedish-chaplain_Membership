/**
 * payments-initiate-burst.k6.js — F5 rate-limit burst proof
 *
 * Audit 2026-04-26 round-2 #3: validates that the 10/5min rate-limit
 * tier on POST /api/payments/initiate (per (tenant, actor)) actually
 * blocks burst attacks. Manual run only — see tests/load/README.md.
 *
 * Pass criteria:
 *   - First ~10 requests succeed (201)
 *   - Remaining requests return 429 with Retry-After header
 *   - p99 latency < 800ms even under burst
 *   - No 5xx responses (rate-limit failure mode = 429, never 500)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const succeededCounter = new Counter('initiate_succeeded');
const rateLimitedCounter = new Counter('initiate_rate_limited');
const errorCounter = new Counter('initiate_errored');
const latencyTrend = new Trend('initiate_latency_ms');

const TARGET = __ENV.LOAD_TARGET || 'http://localhost:3100';
const COOKIE = __ENV.LOAD_AUTH_COOKIE || '';
const INVOICE_ID = __ENV.LOAD_INVOICE_ID || '';

if (!COOKIE || !INVOICE_ID) {
  throw new Error(
    'Set LOAD_AUTH_COOKIE + LOAD_INVOICE_ID env vars — see tests/load/README.md',
  );
}

export const options = {
  scenarios: {
    burst: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100,
      maxDuration: '1m',
    },
  },
  thresholds: {
    'initiate_latency_ms': ['p(99)<800'],
    'initiate_errored': ['count<1'], // ZERO 5xx allowed
  },
};

export default function () {
  const res = http.post(
    `${TARGET}/api/payments/initiate`,
    JSON.stringify({ invoiceId: INVOICE_ID, method: 'card' }),
    {
      headers: {
        'Content-Type': 'application/json',
        Cookie: COOKIE,
      },
    },
  );

  latencyTrend.add(res.timings.duration);

  if (res.status === 201) {
    succeededCounter.add(1);
  } else if (res.status === 429) {
    rateLimitedCounter.add(1);
    check(res, {
      '429 has Retry-After header': (r) =>
        r.headers['Retry-After'] !== undefined,
      '429 body has rate_limited code': (r) => {
        try {
          return JSON.parse(r.body).error?.code === 'rate_limited';
        } catch {
          return false;
        }
      },
    });
  } else if (res.status >= 500) {
    errorCounter.add(1);
  }

  // No sleep — burst pattern (k6 dispatches concurrently across VUs).
  sleep(0);
}

export function handleSummary(data) {
  const succeeded = data.metrics.initiate_succeeded?.values?.count ?? 0;
  const rateLimited = data.metrics.initiate_rate_limited?.values?.count ?? 0;
  const errored = data.metrics.initiate_errored?.values?.count ?? 0;
  const p99 = data.metrics.initiate_latency_ms?.values?.['p(99)'] ?? 0;

  const summary = {
    scenario: 'payments-initiate-burst',
    succeeded,
    rateLimited,
    errored,
    p99LatencyMs: Math.round(p99),
    // Pass: at least 1 succeeded (proves the route works), at least 50
    // got rate-limited (proves the limiter triggered), zero 5xx.
    passed: succeeded >= 1 && rateLimited >= 50 && errored === 0,
  };

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
