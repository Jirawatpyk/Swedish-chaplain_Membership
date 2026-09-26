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

A different failure from the one above: a PDF download cannot find its
object in Vercel Blob. Usually the key is stored on the row and the object
is gone. In one receipt case (step 1, wildcard key) the row has no key at all.

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
  and `blobKey`, on every admin and portal PDF route and the zero-rate
  certificate route.

**There is no undo in Blob storage.** Vercel Blob keeps no versions. A
re-render is not a restore either: `@react-pdf` output is not
byte-identical from one render to the next, so a re-rendered PDF never
matches the stored `pdf_sha256` / `receipt_pdf_sha256`. Never hand-edit
`pdf_blob_key`, `receipt_pdf_blob_key`, `pdf_sha256` or `receipt_pdf_sha256`
to point at other bytes. The stored sha256 is the tax document's integrity
anchor.

**What to do.**

1. **Identify the key and its row.** Take `blobKey` from the route line.
   - **A key with a literal `*`**
     (`invoicing/<tenant>/<fy>/<invoiceId>_receipt_v*.pdf`) is not an object
     name. The receipt route builds it when the row has **no** receipt key
     (`receipt_pdf_blob_key IS NULL`) and its main PDF is not a receipt.
     Nothing is missing from the store. Read the row's `receipt_pdf_status`:
     `pending` means the worker has not rendered yet (an admin download
     reaches this branch; a member gets 425 instead). Wait, and if it stays
     `pending` for more than an hour, use the diagnostic steps at the top of
     this runbook. (A `failed` row never gets here: the route answers
     `receipt_pdf_failed` first.) `rendered` or NULL with no receipt key is
     a data defect: escalate to the maintainer. Never run step 2 with a
     wildcard key.
   - **Any other key**: find the column that holds it.
     ```sql
     SELECT invoice_id, status, pdf_doc_kind, receipt_pdf_status,
            pdf_template_version, receipt_pdf_template_version,
            pdf_blob_key, pdf_sha256,
            receipt_pdf_blob_key, receipt_pdf_sha256,
            zero_rate_cert_blob_key
     FROM invoices
     WHERE tenant_id = $TENANT
       AND $KEY IN (pdf_blob_key, receipt_pdf_blob_key, zero_rate_cert_blob_key);

     SELECT credit_note_id, pdf_blob_key, pdf_sha256
     FROM credit_notes
     WHERE tenant_id = $TENANT AND pdf_blob_key = $KEY;
     ```
   - **As-paid rows.** On a row issued as paid (`pdf_doc_kind` =
     `receipt_combined` or `receipt_separate`), the main PDF IS the receipt
     and `receipt_pdf_blob_key` is NULL by design. The receipt route's 502
     then carries `pdf_blob_key`. Treat it as a main-PDF case (step 4), not
     step 3: the worker renders only a separate receipt.
2. **Confirm the object is really absent** (not a token or store problem).
   The read-only script `scripts/blob-migration/check-invoice-keys-prod.mjs`
   lists every key the database references (invoice, receipt, zero-rate
   certificate and credit-note PDFs, tenant logo) that the store does not
   hold. Before trusting its answer:
   - It lists the store with `NEW_BLOB_TOKEN`, else `SG_READ_WRITE_TOKEN`.
     It never reads `BLOB_READ_WRITE_TOKEN`, the variable the app uses. In
     the local `.env.production` those two tokens differ (checked
     2026-09-23), and the repo cannot tell which one production runs today.
     Pass production's own token explicitly:
     ```bash
     F="$(mktemp)"   # outside the repo: .env.blob-probe is not gitignored
     vercel env pull "$F" --environment=production --yes
     TOKEN="$(grep '^BLOB_READ_WRITE_TOKEN=' "$F" | cut -d= -f2- | tr -d '"')"
     rm "$F"
     if [ -n "$TOKEN" ]; then
       NEW_BLOB_TOKEN="$TOKEN" node --env-file=.env.production \
         scripts/blob-migration/check-invoice-keys-prod.mjs
     else
       echo "no production BLOB_READ_WRITE_TOKEN pulled: stop"
     fi
     ```
     Stop if the token comes back empty. The script would silently fall
     back to `SG_READ_WRITE_TOKEN`. A wrong token lists another store and
     reports nearly every key missing.
   - The tenant is hardcoded to `swecham`
     (`set_config('app.current_tenant', 'swecham', …)`); `TENANT_SLUG` is
     not read. The script does not cover any other tenant. (Its header
     names `scripts/check-invoice-keys-prod.mjs`; the file is under
     `scripts/blob-migration/`.)

   Many keys missing at once points at the store or the token, not at one
   document: stop and escalate to the maintainer.
3. **Separate receipt (`receipt_pdf_blob_key`) on an invoice with
   `status = 'paid'` — and only then.** Re-render through the async worker
   with **Path A** steps 3–5 above. Set `$TPL_VERSION` to the row's
   `receipt_pdf_template_version`: the worker writes the key
   `…_receipt_v<version>.pdf`, so the same version rewrites the same key.
   The receipt number is already allocated, so §86/§87 numbering is
   untouched. The worker stores a NEW `receipt_pdf_sha256`: the content is
   the same (pinned template, frozen snapshots) but the bytes differ from
   any copy a member already downloaded. Put the old sha256 from step 1 in
   the ticket.

   **Do not reset a receipt on any other status.** A receipt stays
   downloadable on `partially_credited` and `credited` (a §86/10 credit
   note does not cancel the §86/4 receipt), but the worker refuses every
   status except `paid` (`invalid_state` in `render-receipt-pdf.ts`). The
   refusal does not mark the row `failed` or count an attempt, and each
   reconcile re-enqueue resets the attempt count to 0. So: each
   outbox row exhausts its retries and emits
   `pdf_render_permanently_failed` (a page), the reconcile cron sees a row
   stuck in `pending` and re-enqueues it about every hour with no end, and
   the member portal answers 425 the whole time. Leave
   `receipt_pdf_status = 'rendered'` (the honest 502) and go to step 4.
4. **Invoice PDF, credit-note PDF, as-paid receipt, or a receipt on a
   non-`paid` invoice: restore the object; do not re-issue.** There is no
   in-app re-render for these (`TODO(F4-T113a)` in
   `get-invoice-pdf-signed-url.ts`). What the repo offers:
   - **Re-upload the original bytes.** The only source the repo knows is
     the old US Blob store from the 2026-07 US → Singapore move.
     `scripts/blob-migration/migrate-blob-us-to-sg.mjs` copies original
     bytes under the same key, so the stored sha256 still matches. It helps
     only for documents that existed before that move, and only if the US
     store still exists. Neither can be verified from the repo
     (`scripts/blob-migration/README.md` records a store suspension). It is
     not a single-key tool: it copies every `swecham/` key the target
     store lacks, and a bulk read has suspended a store before. It is a
     maintainer decision; run `--dry-run` first. After any re-upload, fetch
     the object and check that its sha256 equals the row's `pdf_sha256` /
     `receipt_pdf_sha256` before calling it restored.
   - **Voided invoice** (`status = 'void'`; its `pdf_blob_key` holds the
     VOID-stamped copy): the `void-pdf-reconcile` cron re-renders the VOID
     overlay for rows marked `void_pdf_reconcile_pending_at`. It was built
     for a failed VOID upload and also re-enqueues the member's
     cancellation email. Setting that marker by hand is a maintainer
     decision; read the cron's header first.
   - **Zero-rate certificate** (`zero_rate_cert_blob_key`): an optional
     scan, pinned at issue, and there is no way to attach it again after
     issue. The certificate NUMBER on the invoice is the compliance record.
     Ask staff for the original certificate, file it outside the app, and
     open a ticket.
   - **No source holds the bytes**: there is no restore. Escalate to
     **Finance and the maintainer** with the invoice or credit-note id, the
     key and the stored sha256.
5. **Void and re-issue is a Finance decision and a last resort, never a
   recovery for a missing file.** It cancels a legally valid §86/4 document
   and burns a new §87 number because a storage object is missing. It is
   also refused for most rows that reach this section:
   - `voidInvoice` accepts only `issued` or `paid`. `partially_credited`,
     `credited` and `void` answer `invalid_status`; a voided invoice cannot
     be voided again.
   - A `paid` membership invoice answers
     `paid_membership_requires_credit_note` (409): it is reversed with a
     §86/10 credit note and a real refund, not a void.
   - A `paid` event invoice answers `paid_invoice_requires_refund` (409): it
     is reversed with a refund, not a void.
   - A credit note has no void flow at all.

   `docs/runbooks/void-on-reissue.md` is the feature-flag runbook for the
   automatic supersede-void of unpaid membership bills. It is not a
   recovery procedure.

## Related

- `docs/runbooks/receipt-pdf-async-rollback.md`
- `docs/observability.md` § 19.3 "Auto-email permanent-failure recovery" (F4 sibling —
  an **inline** section, not a file. This entry previously pointed at
  `docs/runbooks/auto-email-permanent-failure.md`, which has never existed; corrected
  2026-07-19)
- `specs/009-online-payment/tasks.md` § T166-11
- `src/app/api/internal/cron/receipt-pdf-reconcile/route.ts`
- `src/modules/invoicing/application/use-cases/render-receipt-pdf.ts`
