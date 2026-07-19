# Runbook — Stale Pending Refund Sweep (T130a)

**Severity**: HIGH (operations follow-up required when triggered)
**Owner**: Payments on-call
**Related code**:
- Use-case: `src/modules/payments/application/use-cases/sweep-stale-pending-refunds.ts`
- Cron handler: `src/app/api/cron/sweep-stale-pending-refunds/route.ts`
- Audit event types emitted by the sweep: `refund_succeeded` / `refund_failed`.
  **`stale_pending_refund_detected` (10y retention) is NOT emitted by the sweep** — since
  A.14 it survives only at `issueRefund`'s synchronous double-fault site. Its enum member
  and migration remain valid; only the emitter changed.
- Migration: `drizzle/migrations/0050_audit_log_stale_pending_refund.sql`
- Metrics: `payments_stale_pending_refund_escalated_total`,
  `payments_cron_sweep_tenant_failed_total`,
  `payments_refund_pending_awaiting_processor_total` — catalogued in
  `docs/observability.md` § 21.1a

**Last verified against source**: 2026-07-19 (observability audit). If you are reading
this after a change to `sweep-stale-pending-refunds.ts`, re-check the branch table below
before trusting it.

## Vercel Cron setup

Scheduled via native Vercel Cron (Pro plan since 2026-07-17).

> **Source of truth for the schedule is `vercel.json`** — the `crons` entry whose
> `path` is `/api/cron/sweep-stale-pending-refunds`. Read it there; this runbook
> deliberately does **not** restate the cron expression. Earlier revisions of this file
> stated the cadence in three places and they had already drifted out of agreement with
> each other (one section said daily, another said hourly). If you need the current
> cadence during an incident:
>
> ```bash
> grep -A1 'sweep-stale-pending-refunds' vercel.json
> ```
>
> Vercel Cron schedules are **UTC** (see `docs/runbooks/cron-jobs.md`). Whatever the
> cadence, note that it is **not** what governs recovery latency — see
> "What actually governs the delay" below.

Whatever cadence is configured, daily-or-better resolution is acceptable because the
sweep is a last-resort recovery for the Postgres double-fault scenario; the common case
is already handled by `issueRefund`'s Phase B catch (Phase 6 review fix C2).

Vercel attaches `Authorization: Bearer ${CRON_SECRET}` automatically on cron invocations; the route validates it (dev-mode accepts unauthenticated calls for manual operator triggering via curl). Rotate `CRON_SECRET` via `vercel env add CRON_SECRET <new-value>` + redeploy.

**Manual trigger** (incident response — sweep at custom cutoff):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  "https://swecham.zyncdata.app/api/cron/sweep-stale-pending-refunds?olderThanHours=2"
```

Override range is bounded `[1, 720]` hours.

## Redundant scheduling: cron-job.org (PAUSED STANDBY — do not rely on it)

> **Status (2026-07-17): cron-job.org is a paused standby.** Native Vercel Cron is the
> **sole** active trigger for this sweep — see `docs/runbooks/cron-jobs.md` § Status.
> The configuration below is retained for the standby-reactivation procedure only.
> **Do not assume a second daily firing exists**: anything reasoning about a ~12h
> worst-case gap (including the `refundFinaliseDoubleFault` docstring in
> `src/lib/metrics.ts`) is assuming a job that is not currently running.

The sweep is idempotent (a second run finds zero stale rows — verified by
`tests/integration/payments/sweep-stale-pending-refunds.test.ts` "idempotent" case), so
dual-firing is safe if the standby is reactivated, and would give us:

- Independent failure domains — if Vercel Cron is degraded, cron-job.org still fires (and vice versa)
- Per-job email alerts on cron-job.org (Vercel Cron only logs)
- Forensic response history (cron-job.org keeps last 100 responses with `swept` counts)

Configure a job at <https://cron-job.org/en/members/jobs/>:

| Field | Value |
|-------|-------|
| Title | `swecham — stale pending refund sweep` |
| URL | `https://swecham.zyncdata.app/api/cron/sweep-stale-pending-refunds` |
| Schedule | Offset roughly half a cycle from the `vercel.json` schedule, so the two triggers interleave rather than fire together. Read the Vercel cadence first (see § Vercel Cron setup) and pick the midpoint — do not hard-code a time here, it drifts |
| Request method | `GET` |
| Headers | `Authorization: Bearer ${CRON_SECRET}` |
| Timeout | 60s |
| Notify on failure | enable email to payments on-call |
| Save responses | last 100 (for forensic review of `swept` counts) |

Both providers send the same `Authorization: Bearer ${CRON_SECRET}` header, so the route auth check works identically for either source. When `swept > 0` is logged from either source, the alert fires once via the standard pino warn channel — no de-duplication needed, because a subsequent sweep finds 0 rows.

## What this runbook covers

The F5 `issueRefund` use-case uses a **two-phase tx model**:

1. **Phase A** — lock payment row, validate, insert `pending` refund row, commit
2. **External** — Stripe `refunds.create` + F4 `issueCreditNoteFromRefund`
3. **Phase B** — update refund → `succeeded` + flip Payment.status, commit
4. **Phase B catch** — if Phase B's tx throws, flip refund → `failed` (recovery)

The **Postgres double-fault scenario**: BOTH Phase B AND its failure-finalise tx throw (e.g. Postgres connection pool exhausted spanning multiple seconds). The `pending` refund row stays forever, and the `refund_in_progress` guard at `issueRefund` step 3 then **permanently blocks all future refunds** on that payment until ops manually intervenes.

### What the sweep actually does (Stripe-aware since A.8 / A.14)

> **If you remember one thing:** the sweep **never blind-fails a row**. It asks Stripe
> first, and the *only* path to `failed` is a Stripe-confirmed `failed`/`canceled`.
> Anything Stripe cannot confirm is **left `pending`** and escalated as an ops signal.
> Earlier revisions of this runbook described a blind-fail that was removed in A.14; if
> you are looking for a row stamped `failureReasonCode='stale_pending_sweep'`, **that
> value does not exist anywhere in the codebase** and never will appear in the data.

For each `pending` refund older than the cutoff (default 24h, override
`?olderThanHours=N`, bounded `[1, 720]`), the sweep resolves the tenant's Stripe account
and calls `retrieveRefund`, then branches:

| Stripe says | Sweep does | Row ends as |
|---|---|---|
| `succeeded` | `finalizeSucceededRefund(path:'sweep_recovery')` — idempotent F4 credit note + refund/payment flip | **`succeeded`** (counted `swept`) |
| `failed` or `canceled` | inline flip to failed, **no** credit note; emits a `refund_failed` audit | **`failed`**, `failureReasonCode` = `` `stripe_refund_${status}` `` → i.e. `stripe_refund_failed` or `stripe_refund_canceled` (counted `swept`) |
| `pending` / `requires_action` / unknown | **skip**, no state change. Emits `refundPendingAwaitingProcessor`; escalates if aged | stays **`pending`** |
| retrieve timed out or errored | **skip**, warn only (`retrieve_timeout` / `retrieve_failed`) | stays **`pending`** |
| _(no `processor_refund_id` on the row)_ | **skip** — cannot be reconciled against Stripe at all; escalates if aged | stays **`pending`** |
| `succeeded` but the F4 credit-note bridge declines | tx rolls back; escalates `credit_note_bridge_declined` | stays **`pending`** |
| row no longer `pending` under the lock | **skip** silently (another writer won the race) | unchanged |

The sweep is **per-tenant**; the cron iterates tenants and calls it once each. Bounded
three ways so a run cannot exceed the function budget (`maxDuration=60`): max 50 rows per
sweep, an 8s per-`retrieveRefund` timeout, and a 35s total wall-clock budget. Rows beyond
a bound are deferred to the next run and **always logged, never silently dropped**.

**The `stale_pending_refund_detected` audit event is no longer emitted by the sweep.** It
survives only at `issueRefund`'s synchronous double-fault site. The sweep's own signal is
the `payments_stale_pending_refund_escalated_total` metric plus a structured `logger.warn`.

### What actually governs the delay

Two independent floors sit between a refund getting stuck and you hearing about it, and
**neither of them is the cron cadence**:

1. **`olderThanHours` (default 24h)** — a row younger than this is not even a candidate.
   This is deliberate: PromptPay refunds settle asynchronously and sweeping too eagerly
   risks acting on a refund that is legitimately still in flight.
2. **`ESCALATION_AGE_MS` (3 days)** — a skipped row only fires the escalation
   metric/warn once it has aged past this. A refund stuck on a non-terminal Stripe status
   is therefore **invisible for up to ~3 days**, regardless of how often the cron runs.

Raising the cron cadence moves the worst case by hours; it does **not** move either floor.
If detection latency is the problem, these constants (in
`sweep-stale-pending-refunds.ts`) are what to change — not `vercel.json`.

The sweep **only reconciles the local F5 row against Stripe** — F4 ledger state may still
need attention. Ops uses this runbook for that.

## When you'll see this alert

Two different situations reach this runbook. **Read the right half — they need opposite
actions.**

| Signal | Meaning | Section |
|---|---|---|
| Pino warn `cron.sweep_stale_pending_refunds.tenant_swept` with `swept > 0` | The sweep **terminalised** rows against Stripe. Usually self-correcting; you are verifying the F4 ledger agrees | § Swept rows |
| `payments_stale_pending_refund_escalated_total > 0`, or its structured `logger.warn` | The sweep **could not** terminalise a row and it has aged past 3 days. **The row is still `pending` and nothing will fix it automatically** | § Escalated rows |
| `payments_cron_sweep_tenant_failed_total > 0` | The sweep itself failed for one tenant — RLS context drift, Neon outage, or a refund-repo regression scoped to that tenant. Neither section applies; check the tenant's DB access first | — |

## Swept rows — immediate actions (within 1 hour)

1. **Identify what the sweep terminalised.** Query the `refunds` table directly — it is
   the authoritative record. (Do **not** query `audit_log` for
   `stale_pending_refund_detected`; the sweep no longer emits it.)

   ```sql
   SELECT
     r.id                    AS refund_id,
     r.payment_id,
     r.invoice_id,
     r.amount_satang,
     r.status,
     r.failure_reason_code,
     r.processor_refund_id,
     r.credit_note_id,
     r.initiated_at,
     r.completed_at,
     r.initiator_user_id     AS admin_user_id,
     EXTRACT(EPOCH FROM (r.completed_at - r.initiated_at)) / 3600 AS hours_pending
   FROM refunds r
   WHERE r.tenant_id = '<TENANT_ID>'
     AND r.completed_at >= NOW() - INTERVAL '24 hours'
     AND r.status IN ('succeeded', 'failed')
     AND (
       r.failure_reason_code LIKE 'stripe_refund_%'   -- swept via Stripe-confirmed terminal
       OR r.credit_note_id IS NOT NULL                -- swept via sweep_recovery success path
     )
   ORDER BY r.completed_at DESC;
   ```

   The corresponding audit rows are `refund_succeeded` / `refund_failed` (not a
   sweep-specific event type):

   ```sql
   -- NB: audit_log's time column is `timestamp`, not `created_at`
   -- (the `refunds` query above correctly uses `completed_at`).
   SELECT timestamp, event_type, actor_user_id, payload
   FROM audit_log
   WHERE tenant_id = '<TENANT_ID>'
     AND event_type IN ('refund_succeeded', 'refund_failed')
     AND timestamp >= NOW() - INTERVAL '24 hours'
   ORDER BY timestamp DESC;
   ```

2. **For each swept refund — check Stripe dashboard**:
   - Open Stripe Dashboard → Payments → search by the refund's `payment_id` (which maps to `processor_payment_intent_id` in our `payments` table)
   - Look at the Refunds tab on the PaymentIntent
   - Note the Stripe refund status (`succeeded` / `failed` / `canceled` / not present)

3. **Branch by Stripe state**:

   **Branch A — Stripe refund DOES NOT EXIST**: the `pending` row was a true orphan; Phase A inserted the row but the Stripe API call never happened (or failed before recording an attempt).

   ⚠️ **If you got here from a swept row, stop — this branch should not be reachable.**
   The sweep cannot terminalise a row it could not confirm against Stripe: with no
   `processor_refund_id` it skips, and a failed `retrieveRefund` also skips. A true orphan
   therefore stays **`pending`** and surfaces as an *escalation*, not a sweep. Go to
   § Escalated rows. (Revisions of this runbook before 2026-07-19 told you to accept a
   "swept `failed` row" here — that row was produced by the blind-fail path removed in
   A.14 and is no longer created.)

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

   **Branch D — Stripe refund FAILED or CANCELED**: the swept `failed` row is correct; no money moved. Confirm the row carries `failure_reason_code = 'stripe_refund_failed'` or `'stripe_refund_canceled'` — that prefix is what proves the sweep terminalised it on Stripe's word rather than a guess. Notify the `initiator_user_id` admin via email so they can re-initiate the refund.

   > **Note on `stripe_refund_%` reason codes generally**: this prefix is also written by
   > `issueRefund` and by the `charge.refund.updated` webhook, so its presence does **not**
   > by itself mean the sweep acted. It is a benign, expected shape — do not treat these
   > rows as incidents on sight. (`f4_bridge_%` is the prefix that indicates an F4-bridge
   > failure needing reconciliation.)

## Escalated rows — the sweep could NOT fix it

**This is the path that needs a human.** The row is still `pending`, no money state
changed, and the `refund_in_progress` guard in `issueRefund` means **every future refund
on that payment is blocked** until it is resolved.

Find them:

```sql
SELECT
  r.id AS refund_id, r.payment_id, r.invoice_id, r.amount_satang,
  r.processor_refund_id, r.initiated_at, r.initiator_user_id,
  EXTRACT(EPOCH FROM (NOW() - r.initiated_at)) / 86400 AS age_days
FROM refunds r
WHERE r.tenant_id = '<TENANT_ID>'
  AND r.status = 'pending'
  AND r.initiated_at < NOW() - INTERVAL '24 hours'
ORDER BY r.initiated_at ASC;
```

Then match to the escalation reason from the structured warn log:

| Escalation reason | What it means | Action |
|---|---|---|
| `missing_processor_refund_id` | `createRefund` succeeded but the `attachProcessorRefundId` tx crashed. **A real Stripe refund may exist** and we have no id for it | Search Stripe Dashboard by the PaymentIntent, find any refund near `initiated_at`, and reconcile manually. Do **not** re-issue before checking — you risk a double refund |
| `stripe_pending` | Stripe still reports the refund `pending`/`requires_action` after ≥3 days | Almost always the `charge.refund.updated` webhook subscription being disabled — check `payments_refund_pending_awaiting_processor_total` and the Stripe endpoint config (go-live gate H-e) before touching the row |
| `credit_note_bridge_declined` | Stripe **succeeded**, but F4 refused to issue the credit note, so the tx rolled back | The most urgent variant: money left Stripe and the F4 ledger has no matching credit note. Diagnose the F4 decline (missing settings row, §87 sequence exhausted, RLS regression) — the row self-heals once F4 accepts, since the bridge is idempotent |

## Prevention / monitoring

- **Alerting anchor is `payments_stale_pending_refund_escalated_total`**, not an audit row — the sweep no longer emits `stale_pending_refund_detected`. See `docs/observability.md` § 21.3a for the proposed rule (severity and window are **not yet ratified**).
- The sweep is reactive — primary defence is `issueRefund`'s Phase B catch (Phase 6 review fix C2). It should fire **rarely** (Postgres double-fault is uncommon).
- ⚠️ **Sweep throughput is currently unobservable.** There is no success/throughput counter. `payments.stale_pending_refund_swept_total` — named in revisions of this runbook before 2026-07-19 — **does not exist in the code and never did**; do not build a dashboard panel or alert on it. What exists today:

  | Signal | Covers |
  |---|---|
  | `payments_stale_pending_refund_escalated_total` | rows the sweep gave up on (escalation only) |
  | `payments_cron_sweep_tenant_failed_total` | the sweep itself erroring for a tenant |
  | `payments_refund_pending_awaiting_processor_total` | rows still awaiting Stripe's async confirmation |

  The use-case does return `sweptCount` in its `Result`, and the cron logs it — so
  **throughput is recoverable from logs but not from metrics**, and only within pino's
  30-day retention. Emitting a success counter is a code change and is deliberately
  **not** done here; see `docs/observability.md` § 21.1a.

## Related runbooks

- `docs/runbooks/out-of-band-refund.md` — for Stripe-dashboard-initiated refunds (separate scenario, FR-011a)
- `docs/runbooks/stale-pending-count.md` — for **payment** rows stuck in pending (analogous, but for the F5 initiate-payment flow)
