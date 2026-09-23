# Runbook — Receipt PDF Permanently Failed (T166)

**Severity:** **page** (PagerDuty primary on-call)
**Trigger:** `pdf_render_permanently_failed` audit row landed.

> The former second trigger — `receipt_pdf_render_failures_total{cause=*}` cumulative ≥ 3
> for the same `invoice_id` — **has been removed: that metric does not exist.** It is
> documented in `docs/observability.md` § 21.1 but has no instrument and no emit site
> anywhere in `src/` (verified 2026-07-19). The audit-row trigger above is real and
> sufficient; the equivalent per-invoice attempt count is
> `invoices.receipt_pdf_render_attempts`, queried in step 2 below.
>
> Note `pdf_render_permanently_failed` is itself an **audit event type, not a metric** —
> alert on it with an `audit_log` query (as step 1 does), not a metric time series.
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
   `receipt_pdf_last_error` **is the only source for the cause** — the
   `receipt_pdf_render_failures_total{cause=…}` metric this step used to
   cross-check against does not exist (see the trigger note at the top).
   The same cause vocabulary applies; match it against the error text:
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

## Missing PDF blob → 502 `blob_missing`

A different failure from the one above: the document was rendered and its
key is stored on the row, but the object is **gone from Vercel Blob**.

**Symptom.** A PDF download answers **502** with body
`{ "error": { "code": "blob_missing" } }` — the admin and portal invoice,
receipt and credit-note PDF routes, and the admin zero-rate certificate view.
Before 2026-09-23 (branch
`fix/invoicing-pdf-blob-missing`) this case answered **500
`internal_error`**: the use cases matched the Vercel SDK's message against
`not found|404`, and `@vercel/blob@2.3.3` says "The requested blob does not
exist". The adapter now classifies the SDK's `BlobNotFoundError` class and
throws the port's `BlobKeyNotFoundError`. A 500 now means a real outage or a
bug, never a missing object.

**Log fields.**
- Use case (`error`): `getInvoicePdfSignedUrl` / `getReceiptPdfSignedUrl` /
  `getCreditNotePdfSignedUrl` / `getZeroRateCertSignedUrl: blob sign failed`,
  with `blobKey`, `tenantId`, `invoiceId` or `creditNoteId`, and
  **`notFound: true`**. `notFound: false` on the same line means the Blob
  call failed for another reason (rate limit, access, outage) and the route
  answered 500.
- Route (`warn`): `GET /api/…/pdf failed` with `errorCode: 'blob_missing'`
  and `blobKey` (the admin credit-note route logs no `blobKey`; use the
  use-case line).

**What to do.**
1. Confirm the object is really absent (not a token or store problem):
   run `scripts/blob-migration/check-invoice-keys-prod.mjs` (read-only) to
   list every referenced key missing from the store. Many keys missing at once points at
   the store or token, not at one document: stop and escalate.
2. **Receipt PDF** (`receipt_pdf_blob_key`): re-render through the async
   worker with **Path A** steps 3–5 above (reset `receipt_pdf_status` to
   `pending`, re-enqueue `receipt_pdf_render`). The render reuses the pinned
   `pdf_template_version`, and the receipt number is already allocated, so
   §86/§87 numbering is untouched.
3. **Invoice, credit note or zero-rate certificate**: there is no automatic
   re-render yet (`TODO(F4-T113a)` in `get-invoice-pdf-signed-url.ts`). A
   zero-rate certificate is an optional uploaded scan, pinned at issue, and
   there is no way to attach it again after issue. The certificate NUMBER on
   the invoice is the compliance record. Ask staff for the original
   certificate and file it outside the app, then open a ticket. For an
   invoice or credit note, escalate to Finance and follow
   **Path B** (void and re-issue per `docs/runbooks/void-on-reissue.md`).
   Never hand-edit `pdf_blob_key` / `pdf_sha256` to point at other bytes.
   The stored sha256 is the tax document's integrity anchor.

## Related

- `docs/runbooks/receipt-pdf-async-rollback.md`
- `docs/observability.md` § 19.3 "Auto-email permanent-failure recovery" (F4 sibling —
  an **inline** section, not a file. This entry previously pointed at
  `docs/runbooks/auto-email-permanent-failure.md`, which has never existed; corrected
  2026-07-19)
- `specs/009-online-payment/tasks.md` § T166-11
- `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts`
- `src/modules/invoicing/application/use-cases/render-receipt-pdf.ts`
