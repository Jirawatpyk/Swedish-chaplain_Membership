# Load + chaos tests

**Status**: 4 scenarios implemented (audit 2026-04-26 round-2 #3 +
self-review #R2-A7 follow-up). Run manually against staging — NOT in
CI yet (rationale at bottom).

## Why

Phase 3 audit identified **no evidence** that the rate-limit tier
(10 / 5min initiate, 20 / 5min cancel) actually protects against burst
attacks, that webhook idempotency holds under concurrent replay, that
the cancel terminal-state guard wins races, or that Stripe SDK timeout
limits prevent function-pool exhaustion. Unit tests prove logic in
isolation; load tests prove behaviour under concurrent + adversarial
load.

## Scenarios

| File | What it stresses | Expected pass criteria |
|------|------------------|------------------------|
| `payments-initiate-burst.k6.js` | 100 concurrent initiate calls from same actor | First 10 succeed (201), remaining 90 → 429 with `Retry-After` header |
| `webhook-replay-storm.k6.js` | Same Stripe `event.id` delivered 50× concurrently | All 50 → 200 `{ received: true }`; (manual check) only ONE row in `payments` for the event's PI id |
| `pi-cancel-flood.k6.js` | 100 cancels on same pending payment row | EXACTLY 1 → 200 `canceled`; rest → 409 `payment_not_cancelable` OR 429 `rate_limited`; zero 5xx |
| `chaos-stripe-timeout.k6.js` | 20 concurrent initiates while Stripe API is delayed 30s via chaos proxy | All requests return 502 `processor_unavailable` within ~35s; zero 503 platform-layer errors |

## Tooling

- **k6** (Grafana) — install via `brew install k6` or
  `winget install -e --id Grafana.k6`. v0.50+
- Target: **staging** (NOT production — payments hit real Stripe sandbox)
- Auth: pre-seed an E2E member token via `pnpm seed:f5-load-fixture`
  (script TODO — Phase 11 cleanup batch)

## Running locally against a dev server

```bash
# 1. Start dev server with feature flag on
pnpm dev

# 2. Set target host
export LOAD_TARGET=http://localhost:3100
export LOAD_AUTH_COOKIE='session=...'  # from a real sign-in
export LOAD_INVOICE_ID='inv_...'  # an issued invoice

# 3. Run the burst scenario
k6 run tests/load/payments-initiate-burst.k6.js
```

## Pass / fail signals

Every scenario emits a single JSON summary at exit:

```
{
  "scenario": "payments-initiate-burst",
  "passed": true,
  "rateLimited": 90,
  "succeeded": 10,
  "rateLimitTriggeredAt": "11:23:00.512",
  "p95LatencyMs": 287,
  "p99LatencyMs": 412
}
```

CI integration (deferred): pipe summary to Grafana Cloud + fail the
build if `passed === false` OR `p99LatencyMs > 800`.

## Why not in CI today

- k6 needs a long-running staging environment (CI ephemeral envs spin
  up too slowly for accurate latency numbers)
- Stripe sandbox has its own rate limits → load tests across CI runs
  could hit them and flake
- Phase 3 review-gate doesn't require load proofs (post-Review work)

Tracked as a **Phase 11 (post-MVP) hardening item**.
