# Contract — Issue Invoice → non-tax ใบแจ้งหนี้ (bill)

**Feature**: `088-invoice-tax-flow-redesign` · **Surface**: `POST /api/invoices/[invoiceId]/issue`
**Use-case**: `issueInvoice` (`src/modules/invoicing/application/use-cases/issue-invoice.ts`)
**Route handler**: `src/app/api/invoices/[invoiceId]/issue/route.ts`
**Covers**: US1 (AS1, AS3), FR-001, FR-003, FR-014 · SC-001, SC-003, SC-005 · **US8** (Embassy §80/1(5) zero-rate, P3), FR-023, FR-024, FR-025 · SC-008

> **Envelope note (AS-IS, verified against the live route)**: F4 routes do **not** use the
> `{ ok, data }` wrapper drawn in the F1/007 contract sketch. Success returns the **serialised
> invoice object directly** (snake_case, `serialiseInvoice`, `_serialise.ts:87`) with HTTP 200;
> failure returns `{ error: { code, ... } }` with the mapped status. Contracts below reflect the
> real shapes.

---

## Purpose

Move an invoice from `draft` → `issued`. **Behaviour change**: issuing now produces a **non-tax
ใบแจ้งหนี้ / Invoice** — NOT a §86/4 ใบกำกับภาษี. The document:

- carries a **non-§87 bill number** allocated from the new `bill` numbering stream
  (`documentType:'bill'`, prefix `SC`, e.g. `SC-2026-000123`), written to the new
  `invoices.bill_document_number_raw` column;
- consumes **NO §87 tax number** — `sequence_number` and `document_number` stay `NULL` for a
  membership/event-with-TIN bill (the §87 allocation moves to payment time — see
  `pay-and-record-payment.md`);
- renders `pdfDocKind:'invoice'` **relabelled in place** to `titleTh='ใบแจ้งหนี้'` /
  `titleEn='Invoice'` — **no** `ต้นฉบับ/ORIGINAL` marker, **no** Revenue-Code §-citation footer
  (`invoice-template.tsx` L196-221, L225, L233-236, L461-463).

Everything else about the endpoint (RBAC, rate limit, idempotent already-issued guard, PDF
render + Blob upload, snapshot pinning) is unchanged from the shipped F4 contract.

## Request

- **Path**: `invoiceId` (uuid).
- **Body**: VAT-treatment fields (US8 / FR-023, FR-024). `issueInvoiceSchema` =
  `{ tenantId, actorUserId, requestId, invoiceId, vatTreatment?, zeroRateCertNo?, zeroRateCertDate?, zeroRateCertBlobKey? }`.
  `tenantId` / `actorUserId` / `requestId` stay server-derived (`tenantId` from host,
  `actorUserId` from session, `requestId` from headers).
- **Headers**: session cookie (F1). Rate limit key `f4:issue:{tenant}:{actor}` — 20 / 5 min.

### VAT-treatment fields (US8 · FR-023 / FR-024)

| field | type | default | note |
|---|---|---|---|
| `vatTreatment` | `'standard' \| 'zero_rated_80_1_5'` | `'standard'` | **per-invoice, case-by-case** (NOT per-member). `'standard'` = VAT 7%; `'zero_rated_80_1_5'` = VAT 0% embassy / int'l-org sale under Revenue Code **§80/1(5)**. **Pinned into the immutable issue-time snapshot** (FR-023). |
| `zeroRateCertNo` | `string` | — | MFA (Protocol Dept) certificate note number, e.g. `กต 0404/…`. **REQUIRED, fail-closed, when `vatTreatment === 'zero_rated_80_1_5'`** (FR-024). |
| `zeroRateCertDate` | `string` (ISO 8601, date) | — | Date of the MFA certificate note. Captured with `zeroRateCertNo` on a zero-rated issue. |
| `zeroRateCertBlobKey` | `string` (optional) | — | Vercel Blob key of the attached MFA certificate scan (reuses the F4 invoice-PDF blob adapter). Optional even when zero-rated — the **number** is the fail-closed gate, the scan is supporting evidence. |

- **Membership is always `'standard'` (VAT 7%)** — a membership subject supplied as
  `zero_rated_80_1_5` is coerced/rejected to standard (see error table). Zero-rate is
  **embassy / int'l-org non-membership sales only** (event / service, e.g. Embassy of Sweden
  expo-booth construction), evidenced by RD-approved certs **VAT 326-24 / 327-24 / 351-24**.

## Response `200`

Serialised invoice DTO (`serialiseInvoice`). Field deltas versus today:

| field | before (tax-invoice-at-issue) | after (non-tax bill) |
|---|---|---|
| `sequence_number` | §87 seq (int) | `null` (membership / event-with-TIN bill) |
| `document_number` | `SC-2026-000123` (§87) | `null` |
| **`bill_document_number_raw`** (new) | — | `"SC-2026-000123"` |
| `status` | `issued` | `issued` |
| `receipt_document_number_raw` | `null` | `null` (not minted until payment) |
| `pdf_sha256` / `pdf_template_version` | tax-invoice PDF | ใบแจ้งหนี้ PDF (template v4) |
| **`vat_treatment`** (new, US8) | — | `"standard"` (VAT 7%) or `"zero_rated_80_1_5"` (VAT 0%); pinned in snapshot (FR-023) |
| **`zero_rate_cert_no`** (new, US8) | — | MFA cert note no. (non-null on `zero_rated_80_1_5`); else `null` |
| `vat_rate` / `vat_amount` | 7% / computed | **0% / `0.00` on `zero_rated_80_1_5`**; total = base (still a VATable §80/1(5) supply, NOT §81-exempt) |

`serialiseInvoice` (`_serialise.ts:87-137`) MUST add `bill_document_number_raw:
invoice.billDocumentNumberRaw ?? null`, plus (US8) `vat_treatment: invoice.vatTreatment` and
`zero_rate_cert_no: invoice.zeroRateCertNo ?? null`.

## Preconditions

- `status === 'draft'` (else `invoice_already_issued`, 409).
- Tenant `tenant_invoice_settings` row exists (else `settings_missing`, 409).
- Buyer resolvable + not archived (`member_not_found` 404 / `member_archived` 409); non-member
  event drafts carry a pinned buyer snapshot (`no_buyer_snapshot` 422).
- **Event-without-TIN still cannot be billed first** — `event_no_tin_requires_paid_issue` (422)
  is retained (bill-first is illegal for a §105-only buyer; those go through
  `issue-as-paid`). Unchanged from 064.

## Error codes (route status map — `issueErrorStatus` + route override)

| code | HTTP | note |
|---|---|---|
| `invoice_not_found` | 404 | |
| `member_not_found` | 404 | |
| `invoice_already_issued` | 409 | idempotent re-issue guard |
| `member_archived` | 409 | |
| `settings_missing` | 409 | |
| `event_no_tin_requires_paid_issue` | 422 | route override (`route.ts:82-84`) |
| `no_buyer_snapshot` | 422 | |
| `invalid_lines` | 422 | |
| `overflow` | 422 | bill-stream number-space exhaustion (server fault, ERROR-logged) |
| `pdf_render_failed` | 500 | server fault |
| `blob_upload_failed` | 500 | server fault |
| `invalid` | 400 | schema parse failure |
| `rate_limited` | 429 | 20 / 5 min bucket |
| `zero_rate_cert_required` | 422 | **US8 / FR-024 fail-closed** — `vatTreatment==='zero_rated_80_1_5'` with a missing/blank `zeroRateCertNo` is **rejected** (no invoice issued). |
| `membership_cannot_be_zero_rated` | 422 | **US8 / FR-025** — a membership subject supplied as `zero_rated_80_1_5` is illegal; membership stays **`standard` (VAT 7%)**. (May instead be coerced to `standard` — see note.) |

> The §87 `overflow` semantics change: at issue it now guards only the **non-§87 bill** stream
> (a gap here does not violate §87). The §87 no-gaps / overflow-must-throw discipline moves to
> `record-payment` / `issue-event-invoice-as-paid`.

### US8 zero-rate validation (FR-024 / FR-025)

- **Fail-closed cert gate**: `vatTreatment==='zero_rated_80_1_5'` **requires** a non-blank
  `zeroRateCertNo`. Missing → `zero_rate_cert_required` (422); **no invoice is issued**. The scan
  (`zeroRateCertBlobKey`) is optional — the cert **number** is the gate.
- **Membership always standard**: a membership subject cannot be zero-rated — it is forced to
  `standard` (VAT 7%). If the request asserts `zero_rated_80_1_5` on a membership subject, reject
  with `membership_cannot_be_zero_rated` (422) rather than silently zero-rate.
- **≥ 5,000 baht warning (NOT blocking)**: a `zero_rated_80_1_5` invoice whose subtotal is
  `< 5,000 THB` surfaces a **non-blocking warning** (`zero_rate_below_threshold_warning`) in the
  200 response / admin UI; the invoice still issues. Each embassy purchase is expected to be
  ≥ 5,000 baht, but the threshold is advisory, not a hard block.

## RBAC

- `admin` only. `requireAdminContext(request, { resource:'invoice', action:'write' })` — a
  `manager` (read-only on finance) is denied at the guard.

## Audit events

- `invoice_issued` (retained; 10y retention). Semantics shift from "tax invoice issued" to
  "ใบแจ้งหนี้ issued"; payload now reflects the **bill** number (`bill_document_number_raw`) and
  records that **no §87 tax number was consumed**. **US8**: the payload also carries
  `vatTreatment` (`'standard'` | `'zero_rated_80_1_5'`) and, when zero-rated, `zeroRateCertNo`
  (the pinned MFA cert note number) — **no separate audit event type is added**. Surfaces on the
  F3 member timeline (`F4MemberTimelineAuditEventType`). For a non-member event buyer, emitted via
  `emitNonMemberInvoiceEvent` (no `member_id`; carries `event_registration_id`).
