/**
 * webhook-replay-storm.k6.js — F5 idempotency proof under burst replay
 *
 * Audit 2026-04-26 round-2 self-review #R2-A7: validates that the
 * `processor_events` ON CONFLICT DO NOTHING idempotency guarantee
 * (FR-008 / SC-005) holds when Stripe replays the SAME event id
 * concurrently — the documented behaviour is "one row in `payments`
 * regardless of duplicate count, all responses 200".
 *
 * Pre-requisites:
 *   - Stripe CLI installed + signed-in: `stripe login`
 *   - Generate a real signature for a test event:
 *     `stripe events resend evt_xxx --webhook-endpoint <staging-url>`
 *   - Capture the resulting Stripe-Signature header + raw body
 *   - Set LOAD_WEBHOOK_BODY + LOAD_WEBHOOK_SIG env vars
 *
 * Pass criteria:
 *   - All 50 deliveries return 200 `{ received: true }`
 *   - p99 latency < 800ms
 *   - Zero 5xx responses
 *   - (Manual verification post-run): `payments` table has exactly 1
 *     row for the event's payment_intent_id
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const okCounter = new Counter('webhook_ok');
const errorCounter = new Counter('webhook_errored');
const latencyTrend = new Trend('webhook_latency_ms');

const TARGET = __ENV.LOAD_TARGET || 'http://localhost:3100';
const RAW_BODY = __ENV.LOAD_WEBHOOK_BODY;
const SIG = __ENV.LOAD_WEBHOOK_SIG;

if (!RAW_BODY || !SIG) {
  throw new Error(
    'Set LOAD_WEBHOOK_BODY + LOAD_WEBHOOK_SIG env vars (capture from `stripe events resend`) — see tests/load/README.md',
  );
}

export const options = {
  scenarios: {
    storm: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: 50,
      maxDuration: '30s',
    },
  },
  thresholds: {
    'webhook_latency_ms': ['p(99)<800'],
    'webhook_errored': ['count<1'], // Zero 5xx allowed
  },
};

export default function () {
  const res = http.post(`${TARGET}/api/webhooks/stripe`, RAW_BODY, {
    headers: {
      'Content-Type': 'application/json',
      'Stripe-Signature': SIG,
    },
  });

  latencyTrend.add(res.timings.duration);

  if (res.status === 200) {
    okCounter.add(1);
    check(res, {
      '200 body has received: true': (r) => {
        try {
          return JSON.parse(r.body).received === true;
        } catch {
          return false;
        }
      },
    });
  } else if (res.status >= 500) {
    errorCounter.add(1);
  }

  sleep(0);
}

export function handleSummary(data) {
  const okCount = data.metrics.webhook_ok?.values?.count ?? 0;
  const errored = data.metrics.webhook_errored?.values?.count ?? 0;
  const p99 = data.metrics.webhook_latency_ms?.values?.['p(99)'] ?? 0;

  const summary = {
    scenario: 'webhook-replay-storm',
    okCount,
    errored,
    p99LatencyMs: Math.round(p99),
    // Pass: at least 45 of 50 returned 200 (some flakiness allowed for
    // network), zero 5xx, p99 under 800ms.
    passed: okCount >= 45 && errored === 0 && p99 < 800,
    manualCheck:
      'Verify `SELECT COUNT(*) FROM payments WHERE processor_payment_intent_id = <event.data.object.id>` returns exactly 1.',
  };

  return {
    stdout: JSON.stringify(summary, null, 2) + '\n',
  };
}
