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
| `zeroRateCertBlobKey` | `string` (optional) | — | Vercel Blob key of the attached MFA certificate scan (reuses the F4 invoice-PDF blob adapter). Upload accepts **PDF or image** (PDF/PNG/JPG) and is **ClamAV-scanned before persistence** (F7.1a inline-upload pattern — reject on virus/oversize/bad-MIME). Optional even when zero-rated — the cert **number** (`zeroRateCertNo`) is the fail-closed gate, the scan is supporting evidence. |

- **Membership is always `'standard'` (VAT 7%)** — a membership subject supplied as
  `zero_rated_80_1_5` is **REJECTED** server-side with `membership_cannot_be_zero_rated` (422,
  **no invoice issued**), **NOT** silently coerced to `standard`. The admin issue form is the
  first line of defence: when the invoice subject is a membership it **hides/disables the
  `vat_treatment` toggle** (with a short explanatory caption), so the illegal request is
  unreachable through the UI — the server 422 is defense-in-depth. Zero-rate is
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
| `membership_cannot_be_zero_rated` | 422 | **US8 / FR-025** — a membership subject supplied as `zero_rated_80_1_5` is illegal and **REJECTED** (no invoice issued); membership stays **`standard` (VAT 7%)**. It is a **reject, NOT a silent coerce**; the admin form additionally hides/disables the toggle for membership subjects (defense-in-depth). |

> The §87 `overflow` semantics change: at issue it now guards only the **non-§87 bill** stream
> (a gap here does not violate §87). The §87 no-gaps / overflow-must-throw discipline moves to
> `record-payment` / `issue-event-invoice-as-paid`.

### US8 zero-rate validation (FR-024 / FR-025)

- **Fail-closed cert gate**: `vatTreatment==='zero_rated_80_1_5'` **requires** a non-blank
  `zeroRateCertNo`. Missing → `zero_rate_cert_required` (422); **no invoice is issued**. The
  primary UX is **inline client-side validation before submit** (`aria-invalid` +
  `aria-describedby` + `role=alert`, localised EN/TH/SV); the 422 `zero_rate_cert_required` + DB
  CHECK are defense-in-depth. The scan (`zeroRateCertBlobKey`) is **optional** — accepts a
  **PDF or image**, is **ClamAV-scanned** (F7.1a upload pattern) before persistence, and is
  supporting evidence only. The cert **number** (`zeroRateCertNo`) is the fail-closed gate, not
  the scan.
- **Membership always standard — reject, not coerce**: a membership subject **cannot** be
  zero-rated. A request asserting `zero_rated_80_1_5` on a membership subject is **REJECTED** with
  `membership_cannot_be_zero_rated` (422, **no invoice issued**) — it is **NOT** silently coerced
  to `standard`. The admin issue form **hides/disables the `vat_treatment` toggle** whenever the
  subject is a membership (error-prevention, with a short explanatory caption), so the illegal
  request cannot be built in the UI; the server-side 422 is defense-in-depth behind that.
  Membership therefore always resolves to `standard` (VAT 7%).
- **≥ 5,000 baht warning (NOT blocking)**: a `zero_rated_80_1_5` invoice whose subtotal is
  `< 5,000 THB` surfaces a **non-blocking warning** (`zero_rate_below_threshold_warning`). The
  **primary surface is inline in the issue form, before submit** (advisory copy next to the
  amount/treatment fields, aria-live so it is announced on reveal); the same
  `zero_rate_below_threshold_warning` field echoed in the **200 response is defense-in-depth**,
  not the primary surface. The invoice still issues either way. Each embassy purchase is expected
  to be ≥ 5,000 baht, but the threshold is advisory, not a hard block.

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
