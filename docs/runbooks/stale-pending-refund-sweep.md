# Runbook — Stale Pending Refund Sweep (T130a)

**Severity**: HIGH (operations follow-up required when triggered)
**Owner**: Payments on-call
**Related code**:
- Use-case: `src/modules/payments/application/use-cases/sweep-stale-pending-refunds.ts`
- Cron handler: `src/app/api/cron/sweep-stale-pending-refunds/route.ts`
- Audit event type: `stale_pending_refund_detected` (10y retention)
- Migration: `drizzle/migrations/0050_audit_log_stale_pending_refund.sql`

## Vercel Cron setup

Scheduled via native Vercel Cron (`vercel.json` entry; Pro plan since 2026-07-17):

```json
{
  "path": "/api/cron/sweep-stale-pending-refunds",
  "schedule": "0 3 * * *"
}
```

Daily 03:00 UTC. Daily-resolution is acceptable because the sweep is a last-resort recovery for the Postgres double-fault scenario; the common case is already handled by `issueRefund`'s Phase B catch (Phase 6 review fix C2).

Vercel attaches `Authorization: Bearer ${CRON_SECRET}` automatically on cron invocations; the route validates it (dev-mode accepts unauthenticated calls for manual operator triggering via curl). Rotate `CRON_SECRET` via `vercel env add CRON_SECRET <new-value>` + redeploy.

**Manual trigger** (incident response — sweep at custom cutoff):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://swecham.zyncdata.app/api/cron/sweep-stale-pending-refunds?olderThanHours=2"
```

Override range is bounded `[1, 720]` hours.

## Redundant scheduling: also configure cron-job.org

We schedule the sweep on **both Vercel Cron AND cron-job.org** as belt-and-suspenders. The sweep is idempotent (the second run of the day finds zero stale rows — verified by `tests/integration/payments/sweep-stale-pending-refunds.test.ts` "idempotent" case), so dual-firing is safe and gives us:

- Independent failure domains — if Vercel Cron is degraded, cron-job.org still fires (and vice versa)
- Per-job email alerts on cron-job.org (Vercel Cron only logs)
- Forensic response history (cron-job.org keeps last 100 responses with `swept` counts)

Configure a job at <https://cron-job.org/en/members/jobs/>:

| Field | Value |
|-------|-------|
| Title | `swecham — stale pending refund sweep` |
| URL | `https://swecham.zyncdata.app/api/cron/sweep-stale-pending-refunds` |
| Schedule | Daily at 15:00 UTC (12 hours offset from Vercel's 03:00 UTC — gives twice-daily coverage) |
| Request method | `GET` |
| Headers | `Authorization: Bearer ${CRON_SECRET}` |
| Timeout | 60s |
| Notify on failure | enable email to payments on-call |
| Save responses | last 100 (for forensic review of `swept` counts) |

Both providers send the same `Authorization: Bearer ${CRON_SECRET}` header, so the route auth check works identically for either source. When `swept > 0` is logged from either source, the alert fires once via the standard pino warn channel — no de-duplication needed because the second sweep of the day finds 0 rows.

## What this runbook covers

The F5 `issueRefund` use-case uses a **two-phase tx model**:

1. **Phase A** — lock payment row, validate, insert `pending` refund row, commit
2. **External** — Stripe `refunds.create` + F4 `issueCreditNoteFromRefund`
3. **Phase B** — update refund → `succeeded` + flip Payment.status, commit
4. **Phase B catch** — if Phase B's tx throws, flip refund → `failed` (recovery)

The **Postgres double-fault scenario**: BOTH Phase B AND its failure-finalise tx throw (e.g. Postgres connection pool exhausted spanning multiple seconds). The `pending` refund row stays forever, and the `refund_in_progress` guard at `issueRefund` step 3 then **permanently blocks all future refunds** on that payment until ops manually intervenes.

The **stale-pending-refund sweep** runs hourly (Vercel Cron) and:

- Finds refunds in `pending` status older than 24h (override via `?olderThanHours=N`)
- Flips them to `failed` with `failureReasonCode='stale_pending_sweep'`
- Emits `stale_pending_refund_detected` audit (10y retention — F4 tax-doc lineage)
- Returns counts so the cron handler logs + emits a metric

The sweep **only restores the local F5 row's terminal state** — Stripe + F4 may have already succeeded on these rows. Ops uses this runbook to reconcile.

## When you'll see this alert

Pino warn line: `cron.sweep_stale_pending_refunds.tenant_swept` with `swept > 0`

## Immediate actions (within 1 hour)

1. **Identify swept refunds**: query `audit_log` for the affected tenant.

   ```sql
   SELECT
     created_at,
     payload->>'refund_id'  AS refund_id,
     payload->>'payment_id' AS payment_id,
     payload->>'invoice_id' AS invoice_id,
     payload->>'amount_satang' AS amount_satang,
     payload->>'age_minutes' AS age_minutes,
     payload->>'original_initiator_user_id' AS admin_user_id
   FROM audit_log
   WHERE event_type = 'stale_pending_refund_detected'
     AND tenant_id = '<TENANT_ID>'
     AND created_at >= NOW() - INTERVAL '24 hours'
   ORDER BY created_at DESC;
   ```

2. **For each swept refund — check Stripe dashboard**:
   - Open Stripe Dashboard → Payments → search by the refund's `payment_id` (which maps to `processor_payment_intent_id` in our `payments` table)
   - Look at the Refunds tab on the PaymentIntent
   - Note the Stripe refund status (`succeeded` / `failed` / `canceled` / not present)

3. **Branch by Stripe state**:

   **Branch A — Stripe refund DOES NOT EXIST**: the `pending` row was a true orphan; Phase A inserted the row but the Stripe API call never happened (or failed before recording an attempt). **No action needed** — the swept `failed` row is correct.

   **Branch B — Stripe refund SUCCEEDED + we have NO F4 credit note**: the most dangerous case. Stripe returned the money but our F4 ledger has no credit note → the invoice is over-credited from the customer's perspective.
     1. Verify with the customer's bank statement if needed (PromptPay only — card refunds are silent on the customer side until the next statement).
     2. Issue a **manual F4 credit note** via `/admin/invoices/{invoiceId}/credit-notes/new` for the same amount with reason `Manual reconciliation — stale-pending-refund sweep recovery`.
     3. Update the `payments` table directly via DB if the payment status needs to flip:
        ```sql
        -- Only if cumulative manual+other-refunds === payment.amount_satang
        UPDATE payments SET status = 'refunded', updated_at = NOW()
        WHERE id = '<PAYMENT_ID>' AND tenant_id = '<TENANT_ID>';
        -- Otherwise:
        UPDATE payments SET status = 'partially_refunded', updated_at = NOW()
        WHERE id = '<PAYMENT_ID>' AND tenant_id = '<TENANT_ID>';
        ```
     4. Email the member explaining the refund + credit note (the original sweep does NOT auto-email).

   **Branch C — Stripe refund SUCCEEDED + we DO have an F4 credit note (created by retry)**: the original swept refund was redundantly issued; ops has already reconciled. Verify the CN amount matches and close the alert.

   **Branch D — Stripe refund FAILED or CANCELED**: the swept `failed` row is correct; no money moved. Notify the original `original_initiator_user_id` admin via email so they can re-initiate the refund.

## Prevention / monitoring

- Alert threshold: any `stale_pending_refund_detected` audit row in the last 24h pages payments on-call.
- The sweep itself is reactive — primary defence is `issueRefund`'s Phase B catch (Phase 6 review fix C2). Sweep should fire **rarely** (Postgres double-fault is uncommon).
- Track the metric `payments.stale_pending_refund_swept_total` per tenant in observability config.

## Related runbooks

- `docs/runbooks/out-of-band-refund.md` — for Stripe-dashboard-initiated refunds (separate scenario, FR-011a)
- `docs/runbooks/stale-pending-count.md` — for **payment** rows stuck in pending (analogous, but for the F5 initiate-payment flow)
