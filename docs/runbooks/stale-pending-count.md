# Runbook — Stale Pending Payment Count Gauge (T138)

**Severity**: ALARM (when `payments.stale_pending_count > 5` for any tenant)
**Owner**: Payments on-call
**Related code**:
- Route: `src/app/api/internal/metrics/stale-pending-count/route.ts`
- Metric: `payments.stale_pending_count{tenant}` (gauge)
- Plan authority: `specs/009-online-payment/plan.md` § VII.Metrics
- Distinct from `docs/runbooks/stale-pending-refund-sweep.md` which sweeps
  pending **refunds** (different table, different recovery path)

## What this gauge surfaces

`payments.status='pending' AND initiated_at < now() - interval '24 hours'`,
grouped by `tenant_id`. These are payments where:

- Member clicked Pay → `/api/payments/initiate` succeeded → Stripe
  PaymentIntent created → DB row inserted with `status='pending'`
- Webhook never confirmed (`payment_intent.succeeded` /
  `payment_intent.payment_failed` / `payment_intent.canceled`) within 24h

Causes — diagnose in order:

1. **Stripe webhook delivery failure** — check Stripe Dashboard → Developers
   → Webhooks for failed deliveries / signature mismatches. Most common.
2. **Member abandoned the flow without canceling** — PromptPay QR shown,
   member walked away, never paid. Stripe will eventually expire the
   PaymentIntent (24h for PromptPay) → fires `payment_intent.canceled`.
3. **App outage during webhook processing** — webhook delivered, app threw,
   Stripe will retry up to 3 days. After 3 days Stripe gives up → row stays.
4. **Postgres double-fault** — `confirmPayment` Phase A committed but
   Phase B threw AND its failure-finalise tx threw. Rare. Last-resort
   recovery is manual operator flip via maintainer-only DB session.

## Cron-job.org configuration

This route is triggered by **cron-job.org**, NOT Vercel Cron. Vercel Hobby
plan caps native crons at once-per-day, which is incompatible with the
5-min cadence this gauge needs.

### Setup steps (one-time, reproducible)

1. Sign in to https://cron-job.org with the SweCham ops account
   (credentials in 1Password vault: `swecham/cron-job-org`).
2. Create new cron-job:
   - **Title**: `Chamber-OS · payments.stale_pending_count`
   - **URL**: `https://swecham.zyncdata.app/api/internal/metrics/stale-pending-count`
   - **Schedule**: `*/5 * * * *` (every 5 minutes, UTC)
   - **Request method**: GET
   - **Headers**:
     - `Authorization: Bearer <CRON_SECRET>` — value from Vercel env
       (rotate via `vercel env add CRON_SECRET <new-value>` + redeploy +
       update cron-job.org header)
   - **Notifications**: enable email on failure (3 consecutive failures)
   - **Timeout**: 30 seconds
   - **Save attempt history**: 100 most recent (default)
3. Click **Run** to verify a 200 OK response with payload:
   ```json
   { "ok": true, "tenantCount": N, "totalEmitted": M, "staleHours": 24, "tenants": [...] }
   ```
4. Confirm the gauge appears in Vercel OTel telemetry within 5 minutes.

### Recreating after account loss

If the cron-job.org account is lost:

1. Create a new account; no migration tooling — entries are typed by hand
2. Re-run the setup steps above
3. Without this trigger the gauge stays at 0 forever and the alert
   `stale_pending_count > 5 for any tenant` will NEVER fire — the cron is
   mandatory, not optional. Audit the gauge dashboard within 6 minutes of
   re-creation.

### Alternative: Vercel Cron Pro upgrade

If/when SweCham upgrades to Vercel Pro, replace the external trigger with
a `vercel.json` cron entry at `*/5 * * * *` and remove the cron-job.org
job. The route handler is unchanged.

## On-call playbook — gauge fires > 5

1. **Triage**: open Vercel Dashboard → Logs → filter by route
   `/api/internal/metrics/stale-pending-count` → confirm gauge values are
   accurate (compare to direct DB query).
2. **Diagnose**: SSH into a maintainer-only psql session and run:
   ```sql
   SELECT id, invoice_id, member_id, method, status, initiated_at,
          processor_payment_intent_id, attempt_seq
   FROM payments
   WHERE status = 'pending'
     AND initiated_at < now() - interval '24 hours'
     AND tenant_id = '<tenant-with-alert>'
   ORDER BY initiated_at;
   ```
3. **For each row**, check Stripe Dashboard → Payment Intents →
   `processor_payment_intent_id`. Three outcomes:
   - **Stripe says succeeded but our row pending** → webhook lost. Manually
     replay the webhook via Stripe Dashboard → Developers → Webhooks →
     resend `payment_intent.succeeded` for that intent ID. Wait 30s →
     verify our row flipped to `succeeded`.
   - **Stripe says canceled / failed / requires_action expired** → flip
     our row to match: `UPDATE payments SET status='canceled',
     completed_at=now() WHERE id='<row-id>'` (use the matching audit
     event type — `payment_canceled`, NOT `payment_failed` for
     dashboard-cancelled).
   - **Stripe says requires_payment_method (PaymentIntent never paid)** →
     PromptPay QR expired or member walked away. Flip our row to
     `canceled` per above.
4. **Document**: open `specs/009-online-payment/incidents/` (create
   directory if absent) → file `<YYYY-MM-DD>-stale-pending-recovery.md`
   with: gauge value at trigger, root-cause class (webhook lost / member
   abandoned / app outage / double-fault), per-row resolution, total time
   to recover.
5. **Escalate** to maintainer if (a) > 50 rows in a single tenant,
   (b) double-fault class confirmed (T130a recovery layer should have
   caught this — file a bug), or (c) cron-job.org has been silent > 30
   minutes (failover to Vercel Pro upgrade or manual /api/internal hit).

## Self-test

Operators may safely seed a stale-pending row in dev to verify the gauge
emits correctly:

```sql
-- DEV ONLY — never run in production
INSERT INTO payments (
  id, tenant_id, invoice_id, member_id, method, status,
  amount_satang, currency, processor_payment_intent_id,
  processor_environment, attempt_seq, initiated_at, actor_user_id,
  correlation_id
) VALUES (
  gen_random_uuid(), 'test-swecham', '<existing-invoice-id>',
  '<existing-member-id>', 'card', 'pending',
  10000, 'THB', 'pi_test_stalepending', 'test', 1,
  now() - interval '25 hours', '<existing-user-id>',
  gen_random_uuid()
);
```

Then trigger the route manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3100/api/internal/metrics/stale-pending-count"
```

Expect a 200 with `tenantCount >= 1`, `totalEmitted >= 1`, and the seeded
tenant in the `tenants[]` array. Clean up by deleting the seed row.
