---
paths:
  - "src/modules/invoicing/**"
  - "src/app/*/admin/invoices/**"
  - "src/app/*/admin/credit-notes/**"
  - "src/app/*/admin/settings/invoicing/**"
  - "src/app/*/portal/invoices/**"
  - "src/app/*/portal/credit-notes/**"
  - "src/components/invoices/**"
  - "src/app/api/invoices/**"
  - "src/app/api/credit-notes/**"
  - "src/app/api/tenant-invoice-settings/**"
  - "tests/**/invoicing/**"
  - "tests/**/invoices/**"
---

# Invoicing (F4 `007-invoices-receipts`, 088 tax redesign)

Money and tax paths are live in production. Review with `financial-integrity-reviewer` + `thai-tax-compliance-auditor`.

- **Stack added**: `@react-pdf/renderer@4.3.0` **exact-pin** (deterministic bilingual PDFs) · `@js-joda/core@^6` + `@js-joda/timezone@^2` (correct Asia/Bangkok fiscal-year boundary for the sequential-number allocator) · `thai-baht-text@^2` · `sharp@^0.34` (server-side logo re-encode — EXIF strip, MIME/dimension enforce) · `fast-check@^4` dev (property test for the credit-note VAT-sum invariant) · Sarabun TTF (OFL) under `public/fonts/sarabun/`, embedded at build time.
- **Tables**: `invoices`, `invoice_lines`, `credit_notes`, `tenant_invoice_settings`, `tenant_document_sequences`. Env `FEATURE_F4_INVOICING` + `BLOB_READ_WRITE_TOKEN` + `CRON_SECRET`.
- **088 redesign**: `document_type` enum `+= 'bill'` · `invoices.bill_document_number_raw` + partial unique index · `members.is_head_office` + `branch_code` · `tenant_invoice_settings.wht_note_th/_en` + `seller_is_head_office` + `seller_branch_code` · amended CHECK constraints on `invoices`.
- **Thai tax documents**: VAT 7%, tax IDs on both parties, a TH-language document, sequential §87 numbering that is gap-free (the `invoicing:` advisory lock, per tenant + document type + fiscal year). Buddhist Era is display-only.
- **Money emails** address the LIVE primary contact through `RecipientLocalePort`, never the frozen snapshot — `pnpm check:money-recipient` (pre-push) guards it.
- `refunds` ↔ `credit_notes` is a mutual RESTRICT FK cycle: unlink and waiver-stamp before deleting either side.
- An imported member reaches auto-draft as `first_payment`.
