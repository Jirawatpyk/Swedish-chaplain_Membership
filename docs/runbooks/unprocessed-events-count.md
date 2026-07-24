# Runbook — Unreconciled `processor_events` Gauge

**Severity**: ALARM (when `payments.unprocessed_events_count > 0` for any tenant, sustained ≥ 15 min)
**Owner**: Payments on-call
**Related code**:
- Route: `src/app/api/internal/metrics/unprocessed-events-count/route.ts`
- Metric: `payments.unprocessed_events_count{tenant}` (gauge)
- Roll-up: `payments_unreconciled_total{path, permanence}` (counter)
- Origin: money-remediation Task 1 (`.superpowers/reviews/money-remediation-plan.md`)
- Distinct from [`stale-pending-count.md`](./stale-pending-count.md) (scans `payments`)
  and [`stale-pending-refund-sweep.md`](./stale-pending-refund-sweep.md) (scans `refunds`).
  This is the only instrument that scans `processor_events`.

## Baseline — read this before interpreting any value

At deploy time (2026-07-19) **production reads 0**, confirmed by a read-only
audit: `payments` 0 rows, `refunds` 0 rows, `processor_events WHERE
processed_at IS NULL` 0 rows. The Stripe path had never carried a real
transaction.

That makes this gauge unusually easy to read: **any non-zero value is new**.
There is no historical backlog to subtract and no "known-bad rows we live
with". Do not let a future non-zero reading get triaged as pre-existing.

(The `dev` Neon branch reads 16 at the same moment — test artefacts. Only the
production series carries the zero baseline.)

## What this gauge surfaces

```sql
SELECT tenant_id, COUNT(*)
FROM processor_events
WHERE processed_at IS NULL
  AND outcome = 'processed'
  AND created_at < now() - interval '15 minutes'
GROUP BY tenant_id
```

A webhook that reaches the dispatcher inserts its row with
`outcome='processed'` in its own step-6 transaction
(`process-webhook-event.ts:374`), and gets `processed_at` only at the tail of
the dispatch transaction (`markProcessed`). A row still showing
`outcome='processed'` with a NULL `processed_at` long after ingest therefore
means: **the dispatcher started, and never finished.**

That is the F-1 divergence shape — money-side state committed (or a bridge
decline returned as a value), the event 200-acked, and nothing to re-drive
it. Stripe does not redeliver a 2xx, and no sweep looks at this table.

### Why the `outcome` predicate is not optional

Three classes of row are `processed_at IS NULL` **permanently and by design**.
Counting them would pin this gauge at a large constant and destroy the
baseline above:

| Row class | Written by | Why `processed_at` stays NULL |
| --- | --- | --- |
| `acknowledged_only` | `api/webhooks/stripe/route.ts:608` — unknown processor account | 200-acked, nothing to dispatch |
| `rejected_signature` | signature-rejection audit | never dispatched |
| `rejected_environment_mismatch` | livemode-mismatch audit | never dispatched |
| `rejected_api_version_mismatch` | API-version-mismatch audit | never dispatched |

The unknown-**event-type** branch (`process-webhook-event.ts:828-834`) also
writes `acknowledged_only`, but sets `outcome` and `processed_at` in ONE
transaction, so a successful one never appears here.

**No blind spot there.** If that transaction fails, both writes roll back and
the row stays at its step-6 values — `outcome='processed'`, `processed_at`
NULL — so this gauge **does** count it, which is correct: the event genuinely
was not reconciled. It also returns a transient `dispatch_failed`, so Stripe
retries and the row normally clears well inside the 15-minute window.

> An earlier revision of this runbook described the above as a blind spot.
> That was wrong. **Do not dismiss a hit as "the documented blind spot"** —
> there isn't one on this path, and every hit is a real unreconciled event.

## Triage

1. **Identify the rows.**
   ```sql
   SELECT id, tenant_id, event_type, created_at, correlation_id
   FROM processor_events
   WHERE processed_at IS NULL AND outcome = 'processed'
     AND created_at < now() - interval '15 minutes'
   ORDER BY created_at;
   ```
2. **Classify by `event_type`.**
   - `payment_intent.succeeded` → **treat as money-moved until proven
     otherwise.** Cross-check the PaymentIntent in the Stripe Dashboard
     against `payments.status` for that invoice. The F-1 signature is: Stripe
     shows a captured charge, `payments.status='succeeded'`, and the invoice
     is still `issued` with no §87 receipt number.
   - `charge.refund.updated` / `charge.refunded` → cross-check `refunds`;
     see [`out-of-band-refund.md`](./out-of-band-refund.md).
3. **Check the roll-up** — `payments_unreconciled_total{path}` tells you which
   divergence site fired, if any did. A non-zero gauge with *no* roll-up
   increment means the dispatcher died mid-flight (function timeout / OOM)
   rather than taking a handled decline branch.
4. **Correlate with logs** by `correlation_id` — the dispatch path logs under
   `stripe-webhook.*` and `confirm_payment.*`.

## Recovery

There is **no automated recovery** for these rows today, which is the point of
the gauge. Reconcile by hand:

- Money captured but the invoice never advanced → follow
  [`event-invoice-legacy-no-tin-remediation.md`](./event-invoice-legacy-no-tin-remediation.md)
  for the invoice-side repair, then flip `processed_at` in a maintainer-only
  DB session once the ledger agrees with Stripe.
- Money not captured → the row is inert; mark it processed with a note.

Do **not** replay the webhook from the Stripe Dashboard without checking
`payments.status` first: on the F-1 path the payment row may already be
`succeeded`, and a replay will short-circuit on the idempotency guard.

## Scheduling

Native Vercel Cron (`vercel.json`, `*/5 * * * *`, GET-only, UTC). Vercel
injects `Authorization: Bearer ${CRON_SECRET}`. This entry takes the cron
count to **34 of the 40-cron plan limit**. A separate feature branch adds 3
more on merge (→ 37/40); the next person to add a cron should re-count rather
than trusting this line.

Full catalogue: [cron-jobs.md](./cron-jobs.md).

## Verifying the instrument itself

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://swecham.zyncdata.app/api/internal/metrics/unprocessed-events-count
```

Returns `{ ok, tenantCount, totalUnprocessed, ageMinutes, tenants[] }`. A 401
means the Bearer is wrong; a 500 `query_failed` means the 10s statement
timeout tripped or Neon was unreachable — the gauge is then **stale, not
zero**, so do not read absence of an alert as health during a Neon incident.
