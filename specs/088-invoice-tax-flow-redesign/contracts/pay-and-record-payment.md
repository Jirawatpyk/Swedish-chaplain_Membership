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
**Covers**: US1 (AS2, AS4), US2 (Original+Copy), US7, US8 (embassy §80/1(5) zero-rate) · FR-002,
   FR-004, FR-005, FR-013, FR-017, FR-019, FR-021, FR-025, **FR-028** (§87-mint mutation contract),
   **FR-029** (member timeline `tax_receipt_issued`), **FR-032** (uniform action feedback),
   **FR-035** (palette + per-row quick action + undo-on-issue-only) · SC-001, SC-002, SC-004,
   SC-008, **SC-012** (timeline + AR correctness)

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
- when the paid invoice's issue-time snapshot pins **`vatTreatment='zero_rated_80_1_5'`** (US8 —
  embassy / international-organization §80/1(5), **non-membership event/service sales only**; every
  membership row stays `'standard'`), the payment-time document is **still a full §86/4
  ใบกำกับภาษี/ใบเสร็จรับเงิน** (`receipt_combined` kind, **ต้นฉบับ + สำเนา**, RC §87 number) — **NOT
  a plain receipt** — but renders at **VAT 0% / 0.00** (`vat_rate` 0%, `vat_amount` 0; a **zero-rated
  VATable supply**, not a §81 exemption) with a **§80/1(5) note** ("VAT 0% under §80/1(5); MFA
  certificate no. …") plus the captured certificate reference/attachment (`zeroRateCertNo` /
  `zeroRateCertDate` / optional blob key). The membership-only WHT note (FR-012) does **not** render
  on these. `standard` receipts (the default) keep **VAT 7%** as today. **Numbering is unchanged** —
  zero-rate never alters the RC §87 stream (FR-025 · SC-008).

**Both paths produce identical content, kind, numbering, and dating (FR-005).** The async worker
`render-receipt-pdf.ts` (gated by `FEATURE_F5_ASYNC_RECEIPT_PDF`) MUST recompute the receipt
**kind** from `invoiceSubject` + buyer TIN via the shared `document-kind.ts` helper — otherwise a
membership receipt on the async path mis-renders as §105-only and loses its §86/4 identity.

**FR-019 (async pending window).** `record-payment.ts` **allocates** the `RC` number in-tx and
**enqueues** the render; the `render-receipt-pdf.ts` worker only **reads**
`receipt_document_number_raw` + `paymentDate` (for dating) — it never allocates. While
`receipt_pdf_status = 'pending'` the invoice surfaces a **"receipt being generated"** state (no
download link yet); the RC number is already final and visible. A **permanent** render failure
(`pdf_render_permanently_failed`, reconcile-cron after retry budget) does **not** re-number — it
reuses the existing **F4 resend / re-render surface** with the **same allocated `RC`**, so the
§87 stream never gaps.

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
- Not a legacy §87-numbered bill with **no** `bill_document_number_raw` — such a row predates the
  bill/receipt split and **cannot be paid**; it must be **voided + re-issued** first so a fresh
  `bill_document_number_raw` (and, at payment, an `RC` receipt number) can be allocated
  (`legacy_invoice_needs_reissue`, 409, FR-017).
- §87 RC allocation is inside the payment transaction; overflow **throws in-tx → rollback → no
  gap** (moves the no-gaps discipline here).

## Error codes (route status map — `/pay/route.ts:97-111`)

| code | HTTP |
|---|---|
| `invoice_not_found` | 404 |
| `invalid_status` | 409 |
| `concurrent_state_change` | 409 |
| `legacy_no_tin_event_needs_remediation` | 409 |
| `legacy_invoice_needs_reissue` | 409 |
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
- **`tax_receipt_issued`** (10y) — **NEW audit event** (new enum value; 4-place add: domain const +
  Drizzle `pgEnum` + audit-event count test + completeness test). Fired at the **`RC`-allocation
  moment inside `record-payment`** (both sync and async paths — allocation happens in-tx before the
  render is enqueued), distinct from `invoice_issued`. This is the **SC-001 signal** — it evidences
  that a §86/4 ใบกำกับภาษี/ใบเสร็จ number was minted at payment; `receipt_rendered` alone (bytes
  landing) is insufficient because allocation and render are decoupled on the async path. The
  payload also captures **`vatTreatment`** (+ **`zeroRateCertNo`** when `zero_rated_80_1_5`) so the
  §80/1(5) zero-rate and its MFA certificate are traceable at the tax-numbering moment (US8).
  **FR-029 (member timeline) — this is the signal `record-payment` emits to drive the F3
  member-timeline `tax_receipt_issued` entry** (keys `admin.members.timeline.taxReceiptIssued`
  EN/TH/SV; interpolates the `RC-…` number + links the RC document). The timeline renders it
  **alongside `invoice_paid`** so the payment moment is not confusingly doubled, while the existing
  `invoice_issued` timeline copy is reworded to "ใบแจ้งหนี้ issued" (FR-014). Together with the
  status + `bill_document_number_raw` AR counting (FR-030), this is the **SC-012** signal
  (timeline shows the RC number after payment; F9 AR / F8 at-risk / member-detail count
  issued-unpaid ใบแจ้งหนี้ correctly).
- `receipt_rendered` (10y) — emitted when the receipt bytes land (async worker) / inline (sync);
  carries the RC `receipt_document_number_raw` + sha256.
- `pdf_render_permanently_failed` (5y) — reconcile-cron after retry budget exhausts.
- (unchanged) `receipt_pdf_downloaded` (10y) on signed-URL issuance.

## Client action UX (admin invoices/documents surface)

Every string introduced below is **new interactive copy** and MUST ship **EN/TH/SV** keys
(Constitution V; TH is mandatory on tax surfaces — shared decision 4). Any status/confirmation
copy is **text** (labelled text, never colour-only) for WCAG 1.4.1.

### FR-028 — §87-mint mutation contract (money-mutation modal)

`recordPayment` — and **every §87-minting action** (the event `issue-as-paid` sibling, the optional
bulk record-payment) — MUST use the **money-mutation modal** (ux-standards § 6.4): a **spinner**
shows while the mutation is in flight and **the dialog stays open until the server returns success
or failure**. **NO optimistic close, NO undo toast.** The shipped **bulk-mark-paid optimistic-UI +
undo-toast pattern is FORBIDDEN here** — an `RC` §87 tax number is minted in-tx at the payment
moment and cannot be silently rolled back client-side, so optimistic/undo must **never** be reused
on this action. (Undo/optimistic are permitted **only** on the F4 issue action — FR-035.)

### FR-032 — uniform action feedback

- **Success** (both the offline `/pay` path and the online settle bridge): a doc-specific toast
  **"Tax receipt RC-… issued"** interpolating `receipt_document_number_raw` (EN/TH/SV keys),
  matching the wider issue/pay/re-render/credit/void toast family.
- **Concurrent stale-write (409)** — `concurrent_state_change` / an `invalid_status` replay on an
  already-`paid` invoice surfaces an **inline "already paid — refresh"** message (NOT a raw error
  toast), prompting a reload to pick up the already-minted `RC` number.
- **Tax-mutation failure** — irreversible §87 failures (`overflow`, `pdf_render_failed`,
  `blob_upload_failed`, and any §87-mint failure) route to an **inline `role=alert` (focus moved to
  it), not a transient toast**, so the admin cannot miss that the mint did not complete.

### FR-035 — palette + per-row quick action + undo-on-issue-only

- **Command palette** (`cmdk`; keys `admin.commandPalette.invoices.*` EN/TH/SV): a **"Record
  payment for …"** action that **deep-links to the pay flow via `?pay=1`** on the invoice detail
  route, plus a **"Re-render tax receipt"** action that reuses the F4 resend / re-render surface
  with the **same allocated `RC`** (never re-numbers — § FR-019).
- **Per-row quick action** — a **"Record payment"** button on each `issued` bill row (defaults to
  **today / bank-transfer**) that opens the same money-mutation modal (FR-028).
- **Bulk record-payment (optional)** — **one `RC` per invoice, sequential, in-tx, gap-free**, and
  explicitly **NOT undoable** (each `RC` is a real §87 mint). Undo/optimistic **never** apply to
  record-payment; a **toast-with-undo (10 s)** is offered **only after ISSUE** (revert to draft —
  no §87 consumed).
