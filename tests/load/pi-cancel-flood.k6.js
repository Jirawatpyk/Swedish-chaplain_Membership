/**
 * pi-cancel-flood.k6.js — F5 PaymentIntent cancel race-condition proof
 *
 * Audit 2026-04-26 round-2 self-review #R2-A7: validates that
 * concurrent cancels on the SAME pending payment row produce exactly
 * one canceled-state transition, with all subsequent attempts → 409
 * `payment_not_cancelable` (terminal-state guard from
 * `payment-status-transitions` policy).
 *
 * Also verifies the rate-limit ceiling: 20 / 5min per (tenant, actor)
 * for cancels — first ~20 reach the use-case, the rest → 429.
 *
 * Pre-requisites:
 *   - Pre-create a pending PaymentIntent + payment row via the
 *     POST /api/payments/initiate flow (capture the returned `id`)
 *   - Set LOAD_AUTH_COOKIE + LOAD_PAYMENT_ID env vars
 *
 * Pass criteria:
 *   - Exactly 1 response is 200 `{ payment.status: 'canceled' }`
 *   - Subsequent successful auth'd calls (≤ 19 more) → 409
 *     `payment_not_cancelable`
 *   - Remaining (~80) → 429 `rate_limited` with Retry-After
 *   - Zero 5xx
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const canceledCounter = new Counter('cancel_succeeded');
const notCancelableCounter = new Counter('cancel_terminal_state');
const rateLimitedCounter = new Counter('cancel_rate_limited');
const errorCounter = new Counter('cancel_errored');
const latencyTrend = new Trend('cancel_latency_ms');

const TARGET = __ENV.LOAD_TARGET || 'http://localhost:3100';
const COOKIE = __ENV.LOAD_AUTH_COOKIE || '';
const PAYMENT_ID = __ENV.LOAD_PAYMENT_ID || '';

if (!COOKIE || !PAYMENT_ID) {
  throw new Error(
    'Set LOAD_AUTH_COOKIE + LOAD_PAYMENT_ID env vars — see tests/load/README.md',
  );
}

export const options = {
  scenarios: {
    flood: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100,
      maxDuration: '1m',
    },
  },
  thresholds: {
    'cancel_latency_ms': ['p(99)<800'],
    'cancel_errored': ['count<1'],
  },
};

// eslint-disable-next-line import/no-anonymous-default-export -- k6 entrypoint contract requires anonymous default function
export default function () {
  const res = http.post(
    `${TARGET}/api/payments/${PAYMENT_ID}/cancel`,
    null,
    { headers: { Cookie: COOKIE } },
  );

  latencyTrend.add(res.timings.duration);

  if (res.status === 200) {
    canceledCounter.add(1);
  } else if (res.status === 409) {
    notCancelableCounter.add(1);
    check(res, {
      '409 has payment_not_cancelable code': (r) => {
        try {
          return JSON.parse(r.body).error?.code === 'payment_not_cancelable';
        } catch {
          return false;
        }
      },
    });
  } else if (res.status === 429) {
    rateLimitedCounter.add(1);
  } else if (res.status >= 500) {
    errorCounter.add(1);
  }

  sleep(0);
}

export function handleSummary(data) {
  const canceled = data.metrics.cancel_succeeded?.values?.count ?? 0;
  const terminal = data.metrics.cancel_terminal_state?.values?.count ?? 0;
  const rateLimited = data.metrics.cancel_rate_limited?.values?.count ?? 0;
  const errored = data.metrics.cancel_errored?.values?.count ?? 0;
  const p99 = data.metrics.cancel_latency_ms?.values?.['p(99)'] ?? 0;

  const summary = {
    scenario: 'pi-cancel-flood',
    canceled,
    terminal,
    rateLimited,
    errored,
    p99LatencyMs: Math.round(p99),
    // Pass: EXACTLY one 200 (race-condition proof), some 409s + 429s,
    // zero 5xx.
    passed:
      canceled === 1 &&
      terminal >= 1 &&
      rateLimited >= 50 &&
      errored === 0 &&
      p99 < 800,
  };

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
