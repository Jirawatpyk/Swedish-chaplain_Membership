# Runbook — Record payment: unconfirmed outcome, and an orphan receipt PDF

**Severity:** ticket (an admin asks), or alarm (`f4-orphan-blob-cleanup-failed`).
**Trigger:** an admin reports a 504 / timeout / "We couldn't confirm whether the
payment was recorded" on the record-payment dialog; or
`invoicing_orphan_blob_cleanup_failed_total{use_case="record_payment"} > 0`
with the ERROR log `recordPayment: orphan receipt blob cleanup failed`.
**Surface:** `POST /api/invoices/{invoiceId}/pay` → `recordPayment`.
**Owner:** Invoicing (F4) maintainers.

---

## 1. A 504 or timeout on `/pay` does not mean the payment was not recorded

The payment, its §87 RC receipt number and the receipt PDF are written in one
transaction. The route then does post-commit work (the F2 plan-change finaliser,
the Stripe PaymentIntent cancel), so the response can be lost or time out after
the commit. The dialog says so (`errors.unconfirmed`) and stays open.

1. **Check before retrying.** Refresh the invoice. If its status is `paid` and it
   shows an RC number, the payment was recorded. Do not record it again.
2. A retry is still safe: `recordPayment` locks the row and returns an
   already-`paid` invoice as a **replay** (200, `replayed: true`). The dialog
   then warns "This invoice was already paid (tax receipt RC-…)". A replay
   never allocates a second RC number.
3. Still `issued`: nothing was recorded (the transaction rolled back). Retry.

Read-only check on a branch you can query (`pnpm db:query` — dev only; prod
needs a read-only console):

```sql
SELECT status, paid_at, receipt_document_number_raw, receipt_pdf_blob_key, receipt_pdf_sha256
FROM invoices WHERE tenant_id = '<tenant>' AND invoice_id = '<invoice-id>';
```

## 2. An orphan receipt PDF after a rollback

The sync receipt render uploads to a deterministic key inside the transaction:
`invoicing/{tenant}/{fy}/{invoiceId}_receipt_v{templateVersion}.pdf`. When a step
after the upload fails, the transaction rolls back and the RC number is
released, but the PDF printed with that number would stay in Blob. Since #60:

- the catch deletes that key best-effort (skipped only after
  `pdf_render_failed`, when nothing was uploaded). It deletes under the
  invoice row lock and only when the locked re-read shows no committed receipt
  at that key, so an ambiguous COMMIT or a retry that won the lock keeps its
  file. It logs `recordPayment: orphan receipt blob cleanup` with `outcome`
  `deleted` or `kept_committed_owner`;
- every upload overwrites the key (`allowOverwrite: true`, under the row lock),
  so a retry of the same invoice replaces any stale bytes, even when the delete
  never ran (for example after a function kill).

**Known gaps (no alarm fires):** a killed function whose invoice is never
retried (it was voided instead), a template-version bump between attempts (the
key changes), and a caller-owned transaction (F5 webhook, F8 offline mark) that
rolls back after `recordPayment` returned ok. In each, a PDF carrying a
released RC number can stay in Blob. It was never sent (the email outbox row
rolled back too). Finding them needs an orphan sweep: Blob keys matching
`_receipt_` that no `invoices.receipt_pdf_blob_key` references.

**When the alarm fires** (`use_case="record_payment"`): the delete failed, so a
PDF carrying a released RC number may still be in Blob.

1. Take `invoiceId` and `blobKey` from the ERROR log line. The log never holds
   the PDF or any payment reference.
2. Read the invoice row (query above).
   - `paid`, with `receipt_pdf_blob_key` = that key: a retry already overwrote
     it. Confirm the stored file matches the row: download it and compare
     `sha256sum <file>` with `receipt_pdf_sha256`. A match closes the alarm.
   - Still `issued` (or `void`), with `receipt_pdf_blob_key` NULL: the file is
     an orphan. An admin may be retrying right now, so re-run the query
     **immediately before deleting** and delete only if it still shows no
     receipt at that key. Delete it in the Vercel dashboard (Storage → Blob →
     the store → find the pathname → Delete), or with the CLI
     (`vercel blob del <url>`; check `vercel blob --help` for the current
     syntax). Re-run the query once more afterwards: if the row turned `paid`
     with that key in between, the receipt file is gone and must be
     re-rendered; escalate to the Invoicing maintainers.
3. A hash mismatch on a `paid` row is tax-document drift: escalate to the
   Invoicing maintainers and follow the receipt re-render path in
   [receipt-pdf-permanently-failed.md](./receipt-pdf-permanently-failed.md).

The async receipt path (`FEATURE_F5_ASYNC_RECEIPT_PDF=true`) uploads outside
this transaction and is not affected.

## Related

- `src/modules/invoicing/application/use-cases/record-payment.ts` — the catch
  and the upload.
- [receipt-pdf-async-rollback.md](./receipt-pdf-async-rollback.md)
- `docs/observability.md` — `invoicing_orphan_blob_cleanup_failed_total`.
