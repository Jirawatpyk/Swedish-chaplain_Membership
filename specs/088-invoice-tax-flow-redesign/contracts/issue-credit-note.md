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
- **#66 `idempotencyKey`** (optional, uuid): one per ADMIN issue attempt; the admin form keeps it
  (sessionStorage per invoice, with the exact request) until a definite answer. A repeat with the
  same key, invoice, `creditTotalSatang`, trimmed `reason` and `membershipEffect` (compared only when
  the note stored one: a full credit of a membership invoice) answers with the
  note already issued — no second §86/10 note, no second §87 number, no audit, no email. The same key
  for any other credit → `concurrent_state_change` (409). A key seen by the non-locking pre-read but not
  under the invoice lock, or a failed reconcile after a race on the key index, issues nothing and
  answers `500` (the form keeps the attempt: a note was seen, or proven by the 23505, under the key). The
  key is looked up before the pre-tx refund guards, so a 429, 401/403, the read-only 503,
  `refund_in_progress` and `online_payment_refundable` say nothing about an earlier attempt: after an
  unknown outcome the form keeps the key for them. A malformed key → 400 `invalid_body`. Stored as `credit_notes.idempotency_key` (mig 0323,
  partial UNIQUE per tenant; a lost race reconciles to the winner). Refund-origin notes never send it.

## Response `201`

`serialiseCreditNote(creditNote)` fields **plus** a sibling `email_delivery` field
(`CreditNoteEmailDelivery` — surfaces `skipped_no_recipient` when the buyer has no email). The CN
DTO's reference fields point at the **RC receipt number** and the receipt's (payment) date.

**#66 `replayed`** (boolean, sibling): `true` when the response is a note an earlier request
already issued (same idempotency key, or same refund). A replay is still `201` and carries no
`membership_end` (the end-membership step ran, or is covered by the hourly backstop, the first time).
An admin key replay writes one `credit_note_issue_replayed` audit row (mig 0324; 10 y; ids only:
`credit_note_id`, `original_invoice_id`, `document_number`, `idempotency_key`, `total_satang`, `path`
`locked_read` | `race_reconcile`), never a second `credit_note_issued`.

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

## Task 68 — `POST /api/credit-notes/attempts/abandon` ("Start over")

Closes a locked admin issue attempt on the server. Same gate (`credit_notes.write`) and rate-limit bucket
(`f4:credit-note:{tenant}:{actor}`) as issuing a note.

- **Body:** `{ invoiceId: uuid, idempotencyKey: uuid }`. Malformed → `400 invalid_body`; unparsable → `400 invalid_json`.
- **Decision**, under the invoice `FOR UPDATE` lock every issue attempt takes:
  - a note already issued under the key → `200 { outcome: 'issued', ...serialised note }` (nothing is closed);
  - otherwise a tombstone in `credit_note_abandoned_attempts` (mig 0326) closes the key for good, one
    `credit_note_attempt_abandoned` audit row is written (10 y, ids only) → `200 { outcome: 'abandoned' }`;
  - a second call → `200 { outcome: 'abandoned' }`, no second row.
- **Refusals:** `404 invoice_not_found`; `409 concurrent_state_change` (the key answers another invoice).
- **Effect on issuing:** `POST /api/credit-notes` with a closed key → `409 attempt_abandoned`, before any §87 number is
  allocated. The lock makes this exact: an attempt holding the lock when Start over arrives commits first and is
  returned as `issued`; one that reaches the lock later finds the tombstone.

- **Scope of the guarantee:** per invoice. The lock serialises Start over against issues **on the same invoice**, which
  is every request the form can send (a stored attempt binds its key to its invoice). A crafted request that reuses a
  closed key on a different invoice is not serialised against the abandon, and is out of scope: it needs
  `credit_notes.write` and the unguessable key, and `keyHitMatches` never returns one invoice's note for another.
