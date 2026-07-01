# Contract — Payment → §86/4 ใบกำกับภาษี/ใบเสร็จรับเงิน (RC receipt) at payment

**Feature**: `088-invoice-tax-flow-redesign`
**Surfaces (two, identical downstream behaviour)**:
1. **Offline** — `POST /api/invoices/[invoiceId]/pay` → `recordPayment`
   (`src/modules/invoicing/application/use-cases/record-payment.ts`;
   route `src/app/api/invoices/[invoiceId]/pay/route.ts`).
2. **Online** — Stripe confirm/webhook → `invoicing-bridge` → `markPaidFromProcessor`
   (`mark-paid-from-processor.ts`) → **the same `recordPayment`**. The bridge is a pure
   passthrough: it maps processor semantics (`method`, `paymentIntentId`, `chargeId`,
   `settlementDate`) onto `recordPayment` input and returns `RecordPaymentError` verbatim.
**Event-as-paid sibling** — `POST /api/invoices/[invoiceId]/issue-as-paid` →
   `issueEventInvoiceAsPaid` mints the receipt in one shot for out-of-band event payments;
   inherits the same §87-RC-at-payment rules.
**Covers**: US1 (AS2, AS4), US2 (Original+Copy), US7 · FR-002, FR-004, FR-005, FR-013 ·
   SC-001, SC-002, SC-004

---

## Purpose

Transition an issued **ใบแจ้งหนี้** (`issued` → `paid`) and, **at the moment of payment**, mint
the single §86/4 + §105ทวิ **ใบกำกับภาษี / ใบเสร็จรับเงิน** (`receipt_combined` kind). The tax
point for a service is receipt of payment (§78/1), so:

- the **§87 tax number** is allocated **now** from the `receipt` stream (prefix `RC`, e.g.
  `RC-2026-000045`) into `invoices.receipt_document_number_raw` — **not reused** from the bill.
  `record-payment.ts` stops reusing `loaded.documentNumber` and always
  `allocateNext({documentType:'receipt', prefix:'RC'})` (retire the `combinedMode`-reuse branch
  ~L493-494/590/644-658; SweCham runs `receiptNumberingMode='separate'`);
- the receipt PDF is **dated at the payment date** (D7), not the bill's issue date
  (was `record-payment.ts:591 issueDate: loaded.issueDate`);
- the §87 fiscal year is derived from the **payment date in Asia/Bangkok** (trap G — a
  Dec-payment recorded in Jan numbers into the Dec FY; never `now()`, never the bill date);
- the receipt renders **ต้นฉบับ (Original) + สำเนา (Copy)** as **two pages in one PDF**, one blob,
  one sha256 (D4 / US2);
- membership receipts keep **VAT-EXCLUSIVE** math (trap I) — only event Model B uses
  `splitVatInclusive`.

**Both paths produce identical content, kind, numbering, and dating (FR-005).** The async worker
`render-receipt-pdf.ts` (gated by `FEATURE_F5_ASYNC_RECEIPT_PDF`) MUST recompute the receipt
**kind** from `invoiceSubject` + buyer TIN via the shared `document-kind.ts` helper — otherwise a
membership receipt on the async path mis-renders as §105-only and loses its §86/4 identity.

## Request

### Offline (`/pay`) — `recordPaymentSchema`
```
{ paymentMethod: 'bank_transfer'|'cheque'|'cash'|'other',   // required
  paymentDate:   'YYYY-MM-DD',                              // required (Asia/Bangkok wall date)
  paymentReference?: string(≤200),
  paymentNotes?:     string(≤1000),
  suppressReceiptEmail?: boolean,                           // F5 sets when tenant auto-email off
  triggeredBy?: 'webhook'|'admin_manual'|'admin_offline_mark',
  processorMethod?: 'stripe_card'|'stripe_promptpay' }
// tenantId / actorUserId / requestId / invoiceId server-derived
```
Rate limit `f4:pay:{tenant}:{actor}` — 20 / 5 min.

### Online (bridge) — `MarkPaidFromProcessorInput`
Client sends **no** invoicing body; the webhook handler supplies `method`, `paymentIntentId`,
`chargeId`, `settlementDate`, actor = `SYSTEM_ACTOR_STRIPE_WEBHOOK`. The bridge maps →
`recordPayment` with `paymentMethod:'other'`, `triggeredBy:'webhook'`, `processorMethod`, the
processor hint in `paymentNotes`, and `paymentDate` = settlement date (Asia/Bangkok). No PAN/CVV
touched — SAQ-A scope unchanged (Constitution IV).

## Response `200`

Serialised invoice DTO (`serialiseInvoice`) with:

| field | value after payment |
|---|---|
| `status` | `paid` |
| `paid_at` | payment timestamp |
| **`receipt_document_number_raw`** | `"RC-2026-000045"` (§87 RC) |
| `receipt_pdf_status` | `rendered` (sync) or `pending`→`rendered` (async) |
| `receipt_pdf_sha256` / `receipt_pdf_template_version` | Original+Copy PDF (template v4) |
| `bill_document_number_raw` | unchanged `"SC-2026-000123"` (bill stays downloadable, FR-015) |

## Preconditions

- `status === 'issued'` (else `invalid_status`, 409 — an idempotent replay on an already-`paid`
  invoice short-circuits to success).
- Buyer/seller snapshot present on the row (`no_snapshot_on_invoice`, 422).
- `paymentDate ∈ [issue_date, today]` in Asia/Bangkok (`payment_date_out_of_range`, 422) —
  server-side mirror of the client clamp; F5-webhook / F8-offline paths are exempt.
- Not a legacy issued no-TIN event row (`legacy_no_tin_event_needs_remediation`, 409).
- §87 RC allocation is inside the payment transaction; overflow **throws in-tx → rollback → no
  gap** (moves the no-gaps discipline here).

## Error codes (route status map — `/pay/route.ts:97-111`)

| code | HTTP |
|---|---|
| `invoice_not_found` | 404 |
| `invalid_status` | 409 |
| `concurrent_state_change` | 409 |
| `legacy_no_tin_event_needs_remediation` | 409 |
| `settings_missing` | 409 |
| `no_snapshot_on_invoice` | 422 |
| `payment_date_out_of_range` | 422 (default 422 arm) |
| `overflow` | 422 |
| `pdf_render_failed` | 500 |
| `blob_upload_failed` | 500 |
| `invalid_json` / `invalid_body` | 400 |
| `rate_limited` | 429 |

Online path returns the **same** `RecordPaymentError` union (bridge introduces no new codes); the
webhook handler maps them to its own retry/ack semantics.

## RBAC

- Offline `/pay`: `admin` only (`requireAdminContext … action:'write'`).
- Online: no human actor — `SYSTEM_ACTOR_STRIPE_WEBHOOK` (reserved seeded user id); the webhook
  route is authenticated by Stripe signature, not session.

## Audit events

- `invoice_paid` (10y; F3-timeline). On the async path the sha256 is `null` at paid-time.
- `receipt_rendered` (10y) — emitted when the receipt bytes land (async worker) / inline (sync);
  carries the RC `receipt_document_number_raw` + sha256.
- `pdf_render_permanently_failed` (5y) — reconcile-cron after retry budget exhausts.
- (unchanged) `receipt_pdf_downloaded` (10y) on signed-URL issuance.
