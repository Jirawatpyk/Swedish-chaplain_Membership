# Runbook — Legacy no-TIN event-invoice remediation (064)

**Severity**: none (planned operator action, not an incident)
**Owner**: Operator + accountant
**Tracked as**: spec §6 items 1, 5, 6 — `docs/superpowers/specs/2026-06-10-event-invoice-paid-flow-design.md`
**Must complete**: BEFORE the 064 flag-flip (items 1 + 5 + 6)

## Background

Before 064, an event fee for a buyer **without** a 13-digit Thai TIN could be
issued bill-first: `issueInvoice` rendered a §105 ใบเสร็จรับเงิน at *issue*
time (status `issued`, money not yet received). Recording the payment later
would render a **second** receipt for the same payment — the §105
double-receipt failure mode the 064 redesign kills. Post-064:

- **New** no-TIN event fees can only go through `issueEventInvoiceAsPaid`
  (one document, issued at the moment of payment). `issueInvoice` rejects
  no-TIN event drafts with `event_no_tin_requires_paid_issue` (422).
- **Legacy** rows issued under the old flow still sit at `status='issued'`
  with a pseudo-receipt PDF already in Blob. They cannot be fixed in code —
  this runbook is the fix.

## Deploy choreography — migrations 0211–0214 vs pre-064 code (wave-3 S8)

The 064 schema changes enforce **instantly** at `db:migrate` time, but a
rolling deploy keeps **pre-064 instances** serving traffic for the deploy
window. In particular `invoices_non_draft_has_doc_kind` (0211) requires
`pdf_doc_kind IS NOT NULL` on every non-draft row — and pre-064
`applyIssue` never writes that column — so **an issuance executed by an
old instance against the migrated database fails with 23514** (and 0214
additionally rejects any post-draft `pdf_doc_kind` write a hotfix script
might attempt). Therefore:

- Apply migrations **0211–0214 together with the 064 release promotion**
  (migrate → promote in one operation; reads and already-issued rows are
  unaffected either way).
- Do **NOT** run pre-064 code against the migrated database for issuance
  work during the window. If production must be rolled back to a pre-064
  build for longer than the deploy window, hold invoice issuance until the
  064 build is restored (the migrations are not designed to be rolled
  back — `pdf_doc_kind` data written by 064 code is meaningful and the
  trigger lock protects it).

## Interim guard (what the system does until remediation completes)

`recordPayment` rejects `invoice_subject='event' AND buyer has no TIN AND
status='issued'` with the typed error `legacy_no_tin_event_needs_remediation`:

- `/api/invoices/{id}/pay` returns **409** with that code.
- The admin payment form shows: *"This event invoice was issued to a buyer
  without a tax ID under the old flow — its issued PDF is already the
  official receipt, so recording a payment would create a second receipt.
  Please follow the remediation runbook instead."*
- `resend-pdf` intentionally keeps re-signing the pinned (legally wrong)
  blob for legacy rows — remediation, not code, fixes those documents.

**Online-payment fence (S0 money trap)** — a MATCHED-member legacy row is
portal-visible and was previously Stripe-payable: the webhook flip then hit
the `recordPayment` guard, which the dispatcher classifies PERMANENT →
200-ack, **no retry, no auto-refund** — money captured against a
stuck-`issued` invoice. The online path is now fenced at every layer:

- F4's payability read (`getInvoiceForPayment` — the read the F5 bridge
  performs before creating a PaymentIntent) rejects the row with the typed
  error `legacy_no_tin_event_not_payable`, so no new PI can be created.
- `POST /api/payments/initiate` returns **409** (existing
  `invoice_not_payable` envelope; the dedicated code stays in the route's
  `useCaseErrorCode` warn log).
- The member portal invoice detail hides the Pay-now button and shows a
  localized "under document correction — contact staff" notice
  (`portal.invoices.detail.legacyNoTinNotPayable`).
- **In-flight PIs** (created before this fence deployed) that confirm via
  webhook still capture money and fail the invoice flip — the webhook emits
  the dedicated error log
  `payments.confirm.legacy_no_tin_event_money_captured` (tenantId,
  invoiceId, paymentId, paymentIntentId, amountSatang).

  **What happens to the DB state depends on `FEATURE_F5_SETTLEMENT_ABORT`.**
  Check the flag in Vercel before acting on this log — the two cases need
  different reconciliation, and getting it backwards means either refunding
  a payment the system still believes is good, or leaving a real payment
  unrecorded.

  | | `FEATURE_F5_SETTLEMENT_ABORT=false` (pre-remediation) | `=true` (money-remediation Task 4) |
  |---|---|---|
  | `payments` row | committed **`succeeded`** | rolled back to **`pending`** |
  | `payment_succeeded` audit | present | **absent** |
  | invoice | stuck `issued` | stuck `issued` |
  | §87 receipt number | possibly **consumed** (register gap) | not consumed |
  | forensic audit | none beyond the log line | one `payment_settlement_rolled_back` row (10y) |
  | Stripe | money **captured** | money **captured** |

  **In BOTH cases Stripe has the member's money.** The rollback unwinds our
  writes; it does not reach Stripe. Do not read a `pending` payment row as
  "nothing happened".

  **On seeing this log — flag OFF:** refund the PI via the Stripe Dashboard
  (out-of-band; the `charge.refunded` webhook records the forensic
  `out_of_band_refund_detected` audit) and remediate the invoice per Step 2
  below. Note the §87 receipt counter may already have advanced past a number
  no document carries — record the gap for the accountant; it cannot be
  reclaimed.

  **On seeing this log — flag ON:** query the forensic row first, then refund
  the PI via the Stripe Dashboard and remediate per Step 2. There is no
  payment row to reverse, because none was ever committed.

  ```sql
  -- Settlement rollbacks awaiting reconciliation. `money_captured` is always
  -- true on these rows; the member has been charged.
  SELECT timestamp,
         tenant_id,
         payload->>'payment_intent_id' AS payment_intent_id,
         payload->>'invoice_id'        AS invoice_id,
         payload->>'amount_satang'     AS amount_satang,
         payload->>'bridge_error_code' AS bridge_error_code
    FROM audit_log
   WHERE event_type = 'payment_settlement_rolled_back'
   ORDER BY timestamp DESC;
  ```

  A `bridge_error_code` of `legacy_no_tin_event_needs_remediation` is this
  runbook's case. Any other code (e.g. `pdf_render_failed`) is a transient
  infrastructure failure, not a legacy-document problem — re-drive the
  payment once the underlying fault clears rather than remediating the
  invoice.

The guard is **interim**: every code site carries the grep-stable marker
`REMOVE-WITH-064-REMEDIATION` (removal checklist below).

## Step 1 — Identify the affected rows (SQL, read-only)

Run as `neondb_owner` (cross-tenant maintenance read). `buyerHasTin` trims,
so a whitespace-only `tax_id` counts as no-TIN — mirror that with
`NULLIF(BTRIM(...), '')`.

```sql
-- (a) BLOCKED rows: issued, unpaid, no-TIN event invoices.
--     These are what the interim guard rejects; each needs void + reissue.
SELECT tenant_id, invoice_id, document_number, issue_date, due_date,
       total_satang, member_identity_snapshot->>'legal_name' AS buyer_name
FROM invoices
WHERE invoice_subject = 'event'
  AND status = 'issued'
  AND NULLIF(BTRIM(member_identity_snapshot->>'tax_id'), '') IS NULL
ORDER BY tenant_id, issue_date;

-- (b) ALREADY-DOUBLED rows: no-TIN event invoices PAID under the old flow
--     (receipt #2 was already minted pre-064). Nothing to void in-system;
--     hand the list to the accountant for the §6 item 5 ภ.พ.30 review.
--     Discriminator: legacy bill-first rows hold an INVOICE-stream §87
--     number (sequence_number set at issue); 064 as-paid no-TIN (β) rows
--     allocate from the RECEIPT stream only and keep sequence_number NULL
--     (their official number is receipt_document_number_raw) — so
--     `sequence_number IS NOT NULL` selects exactly the legacy rows,
--     independent of any cutover date.
SELECT tenant_id, invoice_id, document_number, receipt_document_number_raw,
       issue_date, payment_date, total_satang
FROM invoices
WHERE invoice_subject = 'event'
  AND status = 'paid'
  AND NULLIF(BTRIM(member_identity_snapshot->>'tax_id'), '') IS NULL
  AND sequence_number IS NOT NULL   -- legacy invoice-stream rows; β (as-paid) rows are NULL
ORDER BY tenant_id, issue_date;
```

(Known example from the spec: `SC-2026-000022`.)

## Step 2 — Void + reissue, per row, WITH the accountant (spec §6 item 1)

For each row from query (a):

1. **Void the issue-time pseudo-receipt in-system** (`issued → void` is a
   legal transition): admin invoice detail → Void, reason
   `legacy no-TIN event document — 064 remediation`. This emits
   `invoice_voided` and preserves the §87 number (voided, never reused).
   Executable for **non-member** legacy rows too (W1 S32 — voidInvoice no
   longer rejects `member_id IS NULL` event rows; the audit row correlates
   via `event_registration_id` instead of `member_id`). The VOID-stamped
   re-render **preserves the original document's title** (W1 S31): a
   legacy §105 ใบเสร็จรับเงิน comes back as a VOID-stamped
   ใบเสร็จรับเงิน — never re-titled as a ใบกำกับภาษี — so the retained
   §87/3 evidence copy keeps the legal identity of the document it
   cancels.
2. **Retain the original AND all copies** of the erroneous document with a
   written cancellation note attached, for the full §87/3 10-year retention
   period. Do NOT delete the blob — the void row keeps pointing at it as the
   retained evidence copy.
3. **If the fee was actually received**: reissue correctly via the new flow —
   `/admin/invoices/new` → Event fee → the registration → *Already paid —
   record & issue receipt* with the REAL payment date. The system issues
   exactly one §105 ใบเสร็จรับเงิน (receipt-stream number). The buyer must
   end up holding **exactly one valid receipt per payment**.
4. **If the fee was never received**: stop after the void — the new draft can
   be created when (and if) the money arrives.

## Step 3 — ภ.พ.30 period correction (spec §6 item 5)

For each legacy no-TIN document (queries (a) AND (b)): if the **issue-date
month** (when output VAT was declared on ภ.พ.30) differs from the **real
payment month** (the §78/1 tax point for these fees), the accountant files
additional ภ.พ.30 returns for the affected months. Surcharge: 1.5%/month on
the underpaid amount. Keep the filed corrections with the cancellation
records from Step 2.

## Step 4 — As-paid receipt error correction going forward (spec §6 item 6)

A post-064 as-paid receipt keyed wrongly (amount / buyer) has **no in-system
correction path**: `paid → void` is illegal and §105 receipts are not
creditable. Worse, a correction against the **same registration is a
dead-end in-system**: the erroneous row sits at `paid` (cannot be voided),
and the partial unique index `invoices_event_registration_uniq` blocks a
second non-void invoice on that registration — so the as-paid flow cannot
mint a replacement document for it. Until a maintenance path exists
(spec §6 item 6), the accountant-approved **interim** procedure is manual,
NOT an in-system reissue:

1. Retain the erroneous receipt (original + copies) with a written
   cancellation note — same §87/3 retention rule as Step 2.2.
2. Prepare a corrected **manual receipt** outside the system (accountant
   issues it under the chamber's manual receipt book / process), for the
   correct amount and buyer.
3. Record the pairing (cancelled in-system number ↔ manual corrected
   receipt) as an entry in the accountant's correction register, so the
   audit trail closes.

(Only when the error is on a DIFFERENT registration — i.e. the fee was keyed
against the wrong attendee and the correct registration has no non-void
invoice yet — can the corrected receipt be issued in-system via the as-paid
flow against that correct registration; the erroneous row still follows
1 + 3 above.)

## Step 5 — Seeds

Regenerate any E2E/demo seeds that produced legacy-shaped no-TIN issued
event rows (spec §6 item 1 tail). As of T15 the committed fixtures were
swept (`tests/e2e/helpers/event-fee-as-paid-seed.ts` resets its own rows);
verify with query (a) against the dev tenant after a seed run.

## Removal checklist — interim guard (after Steps 1–3 are signed off)

Query (a) MUST return zero rows on every production tenant first. Then
delete every site marked `REMOVE-WITH-064-REMEDIATION`:

| # | Site | What to remove |
|---|---|---|
| 1 | `src/modules/invoicing/application/use-cases/record-payment.ts` | the guard branch (`legacy_no_tin_event_needs_remediation` early-return) |
| 2 | `src/modules/invoicing/application/use-cases/record-payment.ts` | the `legacy_no_tin_event_needs_remediation` member of `RecordPaymentError` |
| 3 | `src/app/api/invoices/[invoiceId]/pay/route.ts` | the `=== 'legacy_no_tin_event_needs_remediation' ? 409` map line |
| 4 | `src/i18n/messages/en.json` + `th.json` + `sv.json` | the `errors.legacy_no_tin_event_needs_remediation` key (×3 locales; JSON cannot carry the marker — grep the key name) |
| 5 | `src/app/(staff)/admin/invoices/_components/payment-form.tsx` | the `code === 'legacy_no_tin_event_needs_remediation'` toast branch |
| 6 | `tests/unit/invoicing/record-payment.test.ts` | the `064 INTERIM — LEGACY issued no-TIN event row` unit pin |
| 7 | `tests/integration/invoicing/record-payment-event-invoice.test.ts` | the `064 INTERIM — LEGACY issued no-TIN event row` integration pin (incl. its direct-insert fixture) |
| 8 | `src/modules/invoicing/application/use-cases/get-invoice-for-payment.ts` | the `legacy_no_tin_event_not_payable` guard + its `GetInvoiceForPaymentError` member |
| 9 | `src/modules/payments/application/ports/invoicing-bridge-port.ts` + `src/modules/payments/infrastructure/invoicing-bridge.ts` | the bridge-union member + the `mapF4GetError` case |
| 10 | `src/modules/payments/application/use-cases/initiate-payment.ts` | the `legacy_no_tin_event_not_payable` error-union member + the short-circuit branch |
| 11 | `src/app/api/payments/initiate/route.ts` | the `legacy_no_tin_event_not_payable` → 409 map case |
| 12 | `src/modules/payments/application/use-cases/confirm-payment.ts` | the `'issued'` resolver arm + the `payments.confirm.legacy_no_tin_event_money_captured` ops log (+ its logger import) |
| 13 | `src/app/(member)/portal/invoices/_utils/legacy-no-tin.ts` (whole file) + `tests/unit/portal/legacy-no-tin.test.ts` (whole file) + `src/app/(member)/portal/invoices/[invoiceId]/page.tsx` + `src/i18n/messages/{en,th,sv}.json` | the extracted pay-gate predicate helper + its unit pin + the page's gate + notice + the `portal.invoices.detail.legacyNoTinNotPayable` key (×3 locales; grep the key name) |
| 14 | `tests/unit/invoicing/get-invoice-for-payment.test.ts`, `tests/unit/payments/invoicing-bridge.test.ts`, `tests/unit/payments/application/initiate-payment.test.ts`, `tests/unit/payments/application/confirm-payment.test.ts`, `tests/contract/payments/post-payments-initiate.contract.test.ts`, `tests/contract/invoices/pay-route-guard.contract.test.ts` | the `REMOVE-WITH-064-REMEDIATION` unit/contract pins |
| 15 | `tests/integration/invoicing/record-payment-event-invoice.test.ts` | the matched-member `legacy_no_tin_event_not_payable` integration pin (incl. its direct-insert fixture) |

Then run `pnpm check:i18n` (key parity), the invoicing unit + contract
suites, and `pnpm vitest run --config vitest.integration.config.ts
tests/integration/invoicing/` before merging the removal PR. Finally mark
spec §6 items 1 + 5 as DONE in the design doc.

## References

- `docs/superpowers/specs/2026-06-10-event-invoice-paid-flow-design.md`
  §3.4 (interim guard rationale) + §6 (items 1, 5, 6).
- Thai RD: §105 (receipt duty), §86/4 (tax-invoice contents), §78/1 (tax
  point), §87/3 (10-year retention), ภ.พ.30 monthly VAT return.
