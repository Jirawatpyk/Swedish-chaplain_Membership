# Contract — Issue Credit Note (§86/10) targets the §86/4 receipt

**Feature**: `088-invoice-tax-flow-redesign` · **Surface**: `POST /api/credit-notes`
**Use-case**: `issueCreditNote` (`src/modules/invoicing/application/use-cases/issue-credit-note.ts`)
**Route handler**: `src/app/api/credit-notes/route.ts`
**Covers**: US6 (AS1, AS2), FR-007 · SC-006

---

## Purpose

Issue a §86/10 **ใบลดหนี้** against a paid membership/event-with-TIN invoice. **Behaviour
change**: the credit note now references and annotates the **§86/4 ใบกำกับภาษี/ใบเสร็จรับเงิน
(the RC receipt)**, never the non-tax ใบแจ้งหนี้ — because the bill carries no input VAT to
reverse. Concretely:

- `originalDocumentNumber` → `loaded.receiptDocumentNumberRaw ?? loaded.documentNumber.raw`
  (was `loaded.documentNumber.raw`, `issue-credit-note.ts:508`) → prints the **RC** number in the
  `อ้างอิงใบกำกับภาษีต้นฉบับ` (`cnRefBlock`) reference block;
- `originalIssueDate` → the **receipt's date** (the payment date, D7), not the bill's issue date;
- the CREDITED annotation (J2) re-renders against the **receipt** blob
  (`loaded.receiptPdf.blobKey`, `kind:'receipt_combined'`), persisted via a new
  `applyReceiptPdfRegeneration` (updates `receipt_pdf_sha256`) — NOT the bill blob
  (`applyInvoicePdfRegeneration`). The re-render reproduces the Original+Copy layout;
- `'invoice'` is dropped from `isCreditAnnotatable` (L194-195) so the non-tax ใบแจ้งหนี้ never
  carries a §86/4-style CREDITED stamp.

The CN keeps its **own** `credit_note` / `CN` §86/10 §87 stream (allocation stays at CN-issue
time; it does **not** move to payment).

## Request

- **Body** (`route.ts:123-130`): `{ invoiceId: uuid, creditTotalSatang: string(decimal→bigint),
  reason: string }`. `creditTotalSatang` is a numeric string (JSON has no bigint) coerced via
  `BigInt(...)` at the route boundary.
- **Headers**: session cookie. Rate limit `f4:credit-note:{tenant}:{actor}` — 20 / 5 min.

## Response `201`

`serialiseCreditNote(creditNote)` fields **plus** a sibling `email_delivery` field
(`CreditNoteEmailDelivery` — surfaces `skipped_no_recipient` when the buyer has no email). The CN
DTO's reference fields point at the **RC receipt number** and the receipt's (payment) date.

## Preconditions

- Parent invoice `status ∈ { paid, partially_credited }` (an **unpaid ใบแจ้งหนี้ is now blocked**
  — `invalid_status`, 409: no §86/4 exists yet, so nothing to credit).
- **New guard — receipt must be materialised**: `receiptPdfStatus === 'rendered'`. Crediting
  while the receipt PDF is `pending` / `failed` (async path) is blocked until it lands. Proposed
  code **`receipt_not_rendered`** → **409** (transient conflict; retriable once rendered).
- Event-without-TIN §105 (`receipt_separate`) stays **non-creditable** — `receipt_not_creditable`
  (422). A §105 receipt is not a §86/4 tax invoice; correct remedy is refund/void.
- `creditTotalSatang ≤ remaining` (else `credit_exceeds_remainder`, 409, with bigint fields
  serialised as strings).

## Error codes (`ERROR_STATUS` map — `route.ts:53-71`)

| code | HTTP | note |
|---|---|---|
| `invoice_not_found` | 404 | |
| `invalid_status` | 409 | includes an unpaid ใบแจ้งหนี้ (no receipt yet) |
| `concurrent_state_change` | 409 | |
| `credit_exceeds_remainder` | 409 | bigint fields → string |
| `receipt_not_rendered` (new) | 409 | receipt PDF pending/failed |
| `settings_missing` | 422 | |
| `no_snapshot_on_invoice` | 422 | |
| `invalid_event_invoice` | 422 | corrupted event row |
| `receipt_not_creditable` | 422 | §105 event-no-TIN receipt |
| `overflow` | 422 | §87 CN-stream exhaustion |
| `pdf_render_failed` | 500 | |
| `blob_upload_failed` | 500 | |
| `invalid_json` / `invalid_body` | 400 | |
| `forbidden` | 403 | non-admin |
| `rate_limited` | 429 | |

Any unlisted `IssueCreditNoteError` code falls through to **422** (`?? 422`).

## RBAC

- `admin` only. The route additionally hard-checks `ctx.current.user.role !== 'admin'` → 403
  (manager is read-only on finance).

## Audit events

- `credit_note_issued` (10y; F3 member timeline). For a non-member event buyer, emitted via
  `emitNonMemberInvoiceEvent` (`event_registration_id`, no `member_id`).
