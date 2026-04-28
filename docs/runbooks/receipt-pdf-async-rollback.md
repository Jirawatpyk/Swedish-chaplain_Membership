# Runbook — Async Receipt PDF Kill-Switch (T166)

**Severity:** **page-level decision** (operator + on-call lead must agree).
**Trigger:** broad async-PDF pipeline issue — multiple tenants showing
`receipt_pdf_pending_count` climbing, or repeated
`pdf_render_permanently_failed` pages in < 1 hour, or webhook ack p95
regressing despite `FEATURE_F5_ASYNC_RECEIPT_PDF=true`.
**Surface:** F5 webhook + F4 invoicing.
**Owner:** Payments / Invoicing.

---

## What it does

`FEATURE_F5_ASYNC_RECEIPT_PDF` is the kill-switch from T166-13. It
controls whether `record-payment.ts` renders the receipt PDF inline
inside the Stripe webhook tx (legacy) or off-loads to the cron worker
(T166 default).

| Flag value | webhook hot path | receipt PDF |
|---|---|---|
| `false` | inline render+upload (slow: 5–15 s) | `receipt_pdf_status` stays `null` (legacy column behaviour) |
| `true` (default after T166 ships) | `receipt_pdf_status='pending'` + outbox enqueue (fast: 1–3 s) | rendered by `/api/cron/outbox-dispatch` worker |

Flipping `true → false` is a **kill-switch**, not a "rollback":

- Webhook latency regresses immediately (the 5–15 s inline render is back).
- Already-paid invoices with `receipt_pdf_status='pending'`/`'failed'`
  STAY in that state until manually recovered (the kill-switch does NOT
  back-fill them). See § "Stuck rows after flip" below.
- Already-rendered receipts continue to serve normally.

## When to flip

**Flip to `false` when ANY of these are true:**

- `receipt_pdf_render_failures_total` rate climbs > 10 / 5 min across
  tenants (broad failure, not a single bad invoice).
- `receipt_pdf_pending_count` gauge climbs > 50 across tenants AND is
  still growing after 30 minutes of investigation.
- `cron.outbox_dispatch.*` is itself unhealthy (worker can't run).
- A bug in `renderReceiptPdf` is corrupting receipt PDFs (golden
  regression).

**Do NOT flip for:**

- A single tenant / single invoice failure — use the
  `receipt-pdf-permanently-failed.md` recovery path instead.
- Webhook latency spikes that aren't traced to the async path
  (Stripe-side latency, DB issue, etc.).

## How to flip

### Step 1 — Vercel env update (production)

```bash
# Verify current value
vercel env ls production | grep FEATURE_F5_ASYNC_RECEIPT_PDF

# Flip to off
vercel env rm FEATURE_F5_ASYNC_RECEIPT_PDF production --yes
echo "false" | vercel env add FEATURE_F5_ASYNC_RECEIPT_PDF production

# Trigger a redeploy (env changes require a fresh build)
vercel deploy --prod
```

Roughly 1–2 min until the new bundle is serving traffic.

### Step 2 — Verify the flip took effect

Watch a fresh `payment_intent.succeeded` webhook log line:

```
record_payment.async_pdf_path enabled=false
```

OR check the audit emit on the next paid invoice — `receipt_pdf_sha256`
should be NON-NULL on `receipt_rendered` audit (means inline path), and
the new invoice's `receipt_pdf_status` should be `null` (not `'pending'`).

### Step 3 — Stuck rows after flip

The flip does NOT back-fill in-flight rows. Either:

**Option A — let the worker drain.**
The reconciliation cron (5-min cadence) keeps re-enqueuing rows under
budget. If the flag was flipped because of a bug in the WORKER itself,
this won't help; go to Option B.

**Option B — manually mark stuck rows resolved.**
For each `receipt_pdf_status='pending'` row that is stuck:

1. Run inline render manually via a one-off script (see
   `scripts/dev-render-receipt.ts` — TODO if not yet written).
2. Update the row directly:
   ```sql
   UPDATE invoices
      SET receipt_pdf_status = 'rendered',
          receipt_pdf_blob_key = $KEY,
          receipt_pdf_sha256 = $SHA,
          receipt_pdf_template_version = $TPL,
          receipt_pdf_last_error = NULL
    WHERE tenant_id = $TENANT AND invoice_id = $INVOICE;
   ```
3. Releasing the gated `invoice_paid` email: pull `next_retry_at` back:
   ```sql
   UPDATE notifications_outbox
      SET next_retry_at = now() - interval '1 second'
    WHERE tenant_id = $TENANT
      AND notification_type = 'invoice_auto_email'
      AND context_data->>'invoice_id' = $INVOICE
      AND status = 'pending';
   ```

## How to flip back (`false → true`)

Once the underlying issue is fixed and the next paid invoice
successfully renders + upload + audit chain on a single staging tenant:

```bash
vercel env rm FEATURE_F5_ASYNC_RECEIPT_PDF production --yes
echo "true" | vercel env add FEATURE_F5_ASYNC_RECEIPT_PDF production
vercel deploy --prod
```

Watch:

- Webhook ack p95 should fall back to ≤ 1.5 s within 5 min.
- `receipt_pdf_render_duration_ms` p95 should track the worker (not the
  webhook).
- `receipt_pdf_pending_count` should drift toward zero as the worker drains.

## Related

- `docs/runbooks/receipt-pdf-permanently-failed.md` — single-row recovery
- `specs/009-online-payment/tasks.md` § T166-13 (kill-switch wiring)
- `src/lib/env.ts` — flag definition (default `false` for 1 release, then `true`)
- `src/modules/invoicing/application/use-cases/record-payment.ts` —
  branch on `deps.asyncReceiptPdf`
