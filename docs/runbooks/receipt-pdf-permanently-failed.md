# Runbook — Receipt PDF Permanently Failed (T166)

**Severity:** **page** (PagerDuty primary on-call)
**Trigger:** `pdf_render_permanently_failed` audit row landed (or `receipt_pdf_render_failures_total{cause=*}` cumulative ≥ 3 for the same `invoice_id`).
**Surface:** F5 async receipt-PDF pipeline (T166).
**Owner:** Payments / Invoicing (F4 + F5 maintainers).

---

## What it means

The async receipt-PDF worker (`renderReceiptPdf` use-case) failed three
times in a row for a single paid invoice. The reconciliation cron
(`/api/internal/cron/receipt-pdf-reconcile`) gave up re-enqueuing and
emitted a `pdf_render_permanently_failed` audit row.

Customer impact:

- Invoice is `status='paid'` (money settled, audit trail intact).
- Member portal renders the "Receipt being prepared…" affordance
  indefinitely instead of a download button (T166-10 gate).
- Member's `invoice_paid` confirmation email is held by the dispatcher
  gate (T166-09) — they have NOT received the email yet.

This is **not a financial integrity issue** (Thai Revenue Code §86/§87
sequence is preserved — the receipt number was allocated synchronously
in the webhook tx). It is a **document delivery** issue.

## Diagnostic steps

1. **Find the audit row.**
   ```sql
   SELECT tenant_id, payload->>'invoice_id' AS invoice_id,
          payload->>'attempts' AS attempts,
          payload->>'pdf_template_version' AS tpl_version,
          created_at
   FROM audit_log
   WHERE event_type = 'pdf_render_permanently_failed'
   ORDER BY created_at DESC
   LIMIT 20;
   ```

2. **Look up the per-attempt failure cause.**
   The worker writes `receipt_pdf_last_error` on every failure:
   ```sql
   SELECT receipt_pdf_status, receipt_pdf_render_attempts,
          receipt_pdf_last_error, pdf_template_version, fiscal_year
   FROM invoices
   WHERE tenant_id = $TENANT AND invoice_id = $INVOICE;
   ```
   Cross-check with `receipt_pdf_render_failures_total{cause=…}` — the
   `cause` label tells you which sub-step blew up:
   - `render_failed` — PDF engine threw (font, layout, data shape).
   - `blob_upload_failed` — Vercel Blob 5xx / network.
   - `invalid_state` — invoice flipped out of `paid` (rare; void race).
   - `invoice_not_found` / `settings_missing` — RLS/tenant glitch.

3. **Check the dispatcher logs.**
   ```
   cron.outbox_dispatch.* requestId=… invoiceId=…
   cron.receipt_pdf_reconcile.row_failed errKind=…
   ```
   The `errKind` field carries the constructor name (PII-safe) of the
   thrown error.

## Recovery procedure

### Path A — fixable (template / data issue)

Most common when a template change shipped without a backfill golden:

1. Reproduce locally: re-run `renderReceiptPdf` with the affected
   `invoice_id` + `tenant_id` against a dev DB clone.
2. Patch the offending template / data shape in code; ship a hotfix.
3. Manually reset the invoice for one more attempt:
   ```sql
   UPDATE invoices
      SET receipt_pdf_status = 'pending',
          receipt_pdf_render_attempts = 0,
          receipt_pdf_last_error = NULL
    WHERE tenant_id = $TENANT AND invoice_id = $INVOICE;
   ```
4. Re-enqueue:
   ```sql
   INSERT INTO notifications_outbox
     (tenant_id, notification_type, to_email, locale, context_data,
      status, attempts, next_retry_at)
   VALUES ($TENANT, 'receipt_pdf_render',
           'system:manual-recovery@swecham',
           'en',
           jsonb_build_object(
             'invoice_id', $INVOICE,
             'fiscal_year', $FISCAL_YEAR,
             'template_version', $TPL_VERSION),
           'pending', 0, now());
   ```
5. Wait for the next outbox-dispatch tick (60 s ladder) — verify
   `receipt_pdf_status='rendered'` and the gated `invoice_paid` email
   ships.

### Path B — unfixable (data corruption, missing bytes)

If the source data is unrecoverable, escalate to Finance. Options:

- **Re-issue manually:** void the original invoice (regular F4 void
  flow), refund the payment, and ask Finance to re-issue. Tax
  consequences must be reviewed (Thai RD §82/3 credit note vs §86 void).
- **Bypass async:** flip kill-switch (see
  `receipt-pdf-async-rollback.md`) and run the worker in inline mode
  for that one tenant — but this only helps for FUTURE invoices.

### Path C — kill-switch (broad outage)

If MANY invoices stuck (≥ 5 distinct rows in 1 hour), the async
pipeline itself is in trouble. Flip the kill-switch:

```
FEATURE_F5_ASYNC_RECEIPT_PDF=false
```

See `docs/runbooks/receipt-pdf-async-rollback.md`. Existing stuck rows
need manual recovery via Path A or B; the flag only affects NEW
payments.

## Post-incident

1. File a ticket with the failure cause + invoice ids touched.
2. If the failure cause is a template/data shape that affects multiple
   tenants, page the F5 lead — a coordinated backfill may be needed.
3. Confirm the on-call alert cleared:
   - `audit_log.payload->>'invoice_id'` dedupe in the cron prevents
     re-paging on the same invoice. To reset, do not `DELETE` the
     audit row (immutable) — once `receipt_pdf_status='rendered'`,
     subsequent ticks won't see the row in the `failed` filter, so the
     paging chain naturally subsides.

## Related

- `docs/runbooks/receipt-pdf-async-rollback.md`
- `docs/runbooks/auto-email-permanent-failure.md` (F4 sibling)
- `specs/009-online-payment/tasks.md` § T166-11
- `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts`
- `src/modules/invoicing/application/use-cases/render-receipt-pdf.ts`
