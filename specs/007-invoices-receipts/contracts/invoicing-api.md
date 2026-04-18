# F4 Invoicing API Contracts

**Feature**: F4 — Membership Invoicing & Thai-Tax Receipts
**Branch**: `007-invoices-receipts`
**Date**: 2026-04-18

All endpoints are JSON over HTTPS, run inside Next.js route handlers, require authenticated session (F1), and enforce tenant isolation via `runInTenant(ctx, fn)` + RLS. Mutation endpoints require `Idempotency-Key` header. All responses follow the F1 `Result<T, E>` shape: `{ ok: true, data: T }` or `{ ok: false, error: { code, message, details? } }`.

**Shared headers**:
- `Authorization` — session cookie (F1) — required on every request.
- `Idempotency-Key: <uuid>` — required on POST / PATCH / DELETE. 24-hour TTL per (tenant, actor, key).
- `Accept-Language: en | th | sv` — controls error-message localisation.

**Shared error codes**:
- `unauthorized` (401) — no valid session.
- `forbidden` (403) — RBAC denial.
- `not_found` (404) — resource missing OR cross-tenant probe (indistinguishable to caller).
- `conflict` (409) — state violation (already paid, already voided, credit exceeds remainder, etc.).
- `validation` (422) — zod validation failure.
- `rate_limited` (429) — Upstash rate-limit hit.
- `read_only_mode` (503) — kill-switch or `READ_ONLY_MODE=true` or `FEATURE_F4_INVOICING=false`.

---

## 1. Admin — Invoices

### 1.1 `POST /api/invoices` — Create draft

**Body**:
```json
{
  "member_id": "uuid",
  "plan_year": 2026,
  "plan_id": "uuid",
  "due_date_override": "2026-02-15",          // optional; defaults to issue_date + tenant.default_net_days at issue time
  "pro_rate_policy_override": "monthly",      // optional; defaults to tenant setting at issue time
  "include_registration_fee": true,           // if member is new this cycle; default auto-derived
  "auto_email_on_issue": true,                // optional; defaults to tenant.auto_email_enabled; per-invoice override
  "notes": "string"                           // optional admin-only note
}
```

**Response 201**:
```json
{
  "ok": true,
  "data": {
    "invoice": { /* Invoice DTO with status='draft', no sequence_number yet */ }
  }
}
```

**RBAC**: `admin` only.
**Audit**: `invoice_draft_created`.

### 1.2 `GET /api/invoices` — List (paginated)

**Query params**: `status`, `fiscal_year`, `member_id`, `cursor`, `limit` (default 50, max 200), `search` (document_number substring).

**Default behaviour**: if the `status` query param is absent, drafts are **excluded** — the list returns `status ∈ {issued, paid, void, credited, partially_credited}`. Clients MUST pass `status=draft` (or `status=all`) to include drafts. This keeps the default financial-review surface uncluttered by admin working state.

**Response 200**:
```json
{
  "ok": true,
  "data": {
    "rows": [ /* Invoice DTO[] with derived overdue flag */ ],
    "next_cursor": "opaque-string-or-null",
    "total_estimate": 1234
  }
}
```

**RBAC**: `admin` + `manager` (read-only).

### 1.3 `GET /api/invoices/[invoiceId]` — Detail

**Response 200**:
```json
{
  "ok": true,
  "data": {
    "invoice": { /* full Invoice DTO incl. lines */ },
    "credit_notes": [ /* CreditNote DTO[] */ ],
    "outbox_deliveries": [ /* recent auto-email + resend attempts */ ],
    "derived": { "overdue": false }
  }
}
```

### 1.4 `PATCH /api/invoices/[invoiceId]` — Edit draft

**Preconditions**: `status = 'draft'`.

**Body**: same shape as create (partial; only provided fields updated).

**Response 200**: updated Invoice DTO.

**RBAC**: `admin`.
**Audit**: `invoice_draft_updated` when meaningful fields change.
**Error**: `conflict` if status is not `draft`.

### 1.5 `DELETE /api/invoices/[invoiceId]` — Delete draft

**Preconditions**: `status = 'draft'`.

**Response 204**.

**RBAC**: `admin`.
**Audit**: `invoice_draft_deleted`.

### 1.5a `POST /api/invoices/[invoiceId]/preview` — Draft PDF preview (watermarked)

**Preconditions**: `status = 'draft'`. Draft has sufficient data to render (member + plan + pricing derivable).

**Body**: `{}` (all data already on the draft).

**Response 200**: PDF body streamed directly (`Content-Type: application/pdf`). **No** JSON envelope, **no** signed URL, **no** Blob write, **no** sequence number consumed, **no** audit event recorded. The PDF is stamped with a watermark layer ("DRAFT / ร่าง — NOT A TAX DOCUMENT") using the production template pipeline in `isPreview=true` mode.

**Rationale** (per FR-001a): closes the "point of no return" UX gap so admins can verify layout + content before committing a sequential tax-invoice number.

**RBAC**: `admin` only.
**No Idempotency-Key required** (preview is read-only from the DB + ephemeral stream; safe to retry freely).
**Errors**: `conflict` (409) if invoice is not a draft; `unprocessable_entity` (422) if draft is incomplete.

### 1.6 `POST /api/invoices/[invoiceId]/issue` — Issue (THE transactional path)

**Preconditions**: `status = 'draft'`. All `tenant_invoice_settings` required fields are set (FR-010).

**Body**: `{}` (all data already on the draft).

**Response 200**:
```json
{
  "ok": true,
  "data": {
    "invoice": {
      "status": "issued",
      "document_number": "SC-2026-000042",
      "fiscal_year": 2026,
      "sequence_number": 42,
      "issue_date": "2026-04-18",
      "due_date": "2026-05-18",
      "subtotal_satang": 5000000,
      "vat_rate_snapshot": "0.0700",
      "vat_satang": 350000,
      "total_satang": 5350000,
      "pdf_sha256": "abc…",
      "auto_email_queued": true,
      /* …full DTO */
    }
  }
}
```

**Transactional guarantees** (implementation): advisory lock → FOR UPDATE → seq++ → snapshot → PDF render → Blob upload → DB commit → audit → outbox insert. Any failure rolls back all DB state; Blob orphan swept later.

**RBAC**: `admin` only.
**Rate limit**: 20 issues / 5 min per `(tenant, actor)`.
**Audit**: `invoice_issued`.
**Errors**:
- `conflict` (409) — not a draft; settings incomplete.
- `pdf_render_failed` (500) — template error (rollback done).
- `rate_limited` (429).

### 1.7 `POST /api/invoices/[invoiceId]/pay` — Record payment

**Preconditions**: `status = 'issued'`.

**Body**:
```json
{
  "method": "bank_transfer",             // 'bank_transfer' | 'cheque' | 'cash' | 'other'
  "payment_date": "2026-04-20",
  "reference": "SCB-20260420-4421",
  "notes": "string"
}
```

**Response 200**: `{ ok: true, data: { invoice: { status: "paid", paid_at: "…", /* + receipt PDF hash */ } } }`.

**RBAC**: `admin` only.
**Audit**: `invoice_paid`.
**Errors**:
- `conflict` (409) — already paid (idempotent replay returns original response), void, or credited.

### 1.8 `POST /api/invoices/[invoiceId]/void` — Void

**Preconditions**: `status = 'issued'` (NOT paid — use credit note for paid).

**Body**:
```json
{ "reason": "Wrong tier selected" }
```

**Response 200**: Invoice DTO with `status = 'void'`.

**RBAC**: `admin` only.
**Audit**: `invoice_voided`.
**Errors**: `conflict` if paid, already void, or credited.

### 1.9 `GET /api/invoices/[invoiceId]/pdf` — Get signed URL

**Response 302** redirect to signed Blob URL (60 s TTL). If Blob is missing (deleted, orphaned, sweeper removed), the handler transparently re-renders from snapshots and re-uploads before redirecting.

**RBAC**: `admin` + `manager`.

### 1.10 `POST /api/invoices/[invoiceId]/resend` — Manual resend

**Body**:
```json
{
  "recipients": ["billing@member.example"],  // optional; default = member's primary contact
  "locale": "th"                             // optional; default = member's locale
}
```

**Response 200**: `{ ok: true, data: { outbox_id, queued_at } }`.

**RBAC**: `admin` only.
**Audit**: `invoice_pdf_resent` (or `receipt_pdf_resent` on paid invoices).

---

## 2. Admin — Credit Notes

### 2.1 `POST /api/credit-notes` — Issue

**Body**:
```json
{
  "original_invoice_id": "uuid",
  "credit_amount_satang": 1070000,         // in satang; ≤ remaining balance
  "reason": "Membership cancelled mid-year"
}
```

**Response 201**:
```json
{
  "ok": true,
  "data": {
    "credit_note": {
      "document_number": "CN-2026-000005",
      "fiscal_year": 2026,
      "sequence_number": 5,
      "credit_amount_satang": 1070000,
      "vat_satang": 74900,
      "total_satang": 1144900,
      "pdf_sha256": "…",
      "original_invoice_id": "…",
      "original_invoice_status_after": "partially_credited"
    }
  }
}
```

**Preconditions**: Original invoice is `paid` or `partially_credited`; requested amount ≤ remaining balance.

**RBAC**: `admin` only.
**Audit**: `credit_note_issued`.
**Errors**:
- `conflict` (409) — original not paid, or credit exceeds remainder.

### 2.2 `GET /api/credit-notes` — List

Same pagination pattern as invoices. Filterable by `fiscal_year`, `original_invoice_id`, `member_id`.

### 2.3 `GET /api/credit-notes/[creditNoteId]` — Detail

Standard DTO.

### 2.4 `GET /api/credit-notes/[creditNoteId]/pdf` — Signed URL

Same behaviour as invoice PDF (including auto-re-render if Blob missing).

### 2.5 `POST /api/credit-notes/[creditNoteId]/resend` — Manual resend

Same shape as invoice resend.

---

## 3. Admin — Tenant Invoice Settings

### 3.1 `GET /api/tenant-invoice-settings`

**Response 200**: current `TenantInvoiceSettings` DTO.

**RBAC**: `admin` + `manager` (read-only).

### 3.2 `PATCH /api/tenant-invoice-settings`

**Body**: partial DTO — any subset of settings fields. `logo_blob_key` MAY be set only to a value returned by § 3.3 logo upload; raw logo binary MUST NOT be accepted here.

**Response 200**: updated DTO.

**RBAC**: `admin` only.
**Audit**: `tenant_invoice_settings_updated` with before/after diff.
**Validation**:
- `vat_rate ∈ [0, 0.30]` (reasonable upper bound for Thai RD scenarios)
- `default_net_days ∈ [0, 365]`
- `fiscal_year_start_month ∈ [1, 12]`
- `registration_fee_satang ≥ 0`
- `legal_name_th`, `legal_name_en`, `tax_id`, addresses — non-empty
- `tax_id` — Thai 13-digit checksum validation (reused from F3 value object)
- `receipt_numbering_mode ∈ {'combined', 'separate'}` — default `combined`
- `auto_email_enabled` — boolean; tenant-level default for per-invoice override
- `billing_reply_to_email` — optional; zod `.email()`; used as `Reply-To` on auto-emails
- `billing_from_name` — optional; 2-80 chars; used as `From:` display name on auto-emails
- `logo_blob_key` — must match a key previously returned by § 3.3; any other value rejected

### 3.3 `POST /api/tenant-invoice-settings/logo` — Logo upload (FR-034, security-critical)

Dedicated endpoint separating logo binary ingress from settings PATCH for defense-in-depth against SVG-injection / SSRF through `@react-pdf/renderer` image handling.

**Request**: `multipart/form-data` with field `file` (single file).

**Validation** (strict — reject outright on any failure):
- MIME whitelist: `image/png` OR `image/jpeg`. SVG + any other MIME → 422 with `unsupported_media_type`.
- Size: ≤ 1,048,576 bytes (1 MB). Larger → 422 with `payload_too_large`.
- Dimensions: 200 ≤ width ≤ 2000 AND 100 ≤ height ≤ 500. Outside range → 422 with `dimension_out_of_range`.
- **Server-side re-encode** via `sharp` (or equivalent) before persisting: strip EXIF, ICC profiles, embedded color profiles, metadata, and any embedded scripts. Re-encode preserves MIME + dimensions + pixel content only.
- Re-encoded blob persists to Vercel Blob under `tenants/{tenant_id}/logo/{sha256}.{png|jpg}` (content-addressed).

**Response 201**:
```json
{
  "ok": true,
  "data": {
    "logo_blob_key": "tenants/{tenant_id}/logo/{sha256}.png",
    "sha256": "abc…",
    "width": 1200,
    "height": 400,
    "mime": "image/png",
    "size_bytes": 245678
  }
}
```

**Subsequent step**: caller PATCHes `/api/tenant-invoice-settings` with `{ "logo_blob_key": "<returned>" }` to apply the new logo.

**RBAC**: `admin` only.
**Rate limit**: 10 uploads / 5 min per `(tenant, actor)` to prevent Blob flood.
**Audit**: `tenant_invoice_logo_uploaded` with `{ sha256, size_bytes, dimensions }`.
**Errors**: `unsupported_media_type` (422), `payload_too_large` (422), `dimension_out_of_range` (422), `rate_limited` (429), `logo_history_cap_reached` (409 — tenant already has 50 historical logos per R2-E5; contact support for manual cleanup).
**Idempotency**: `Idempotency-Key` header required (per shared-headers convention). A retry within 24 h with the same key returns the original `logo_blob_key` without re-uploading to Blob. Vercel's default multipart body-size limit (4.5 MB) comfortably exceeds the 1 MB cap; no runtime config needed.

---

## 4. Member — Portal

### 4.1 `GET /api/portal/invoices` — Own list

Filtered to the member's own company. Excludes drafts.

**Response 200**: `{ ok: true, data: { rows: [/* InvoiceDTO[] */] } }`.

**RBAC**: `member` (scoped to their own `member_id`).

### 4.2 `GET /api/portal/invoices/[invoiceId]/pdf` — Signed URL

Ownership check (invoice's `member_id` ≡ session's `member_id`); else 404 + `invoice_cross_tenant_probe` audit.

---

## 5. Cross-feature — F3 member surface

### 5.1 `GET /api/members/[memberId]/invoices` (FR-032)

List invoices scoped to a specific member (admin-facing; the F3 member page uses this).

**Response 200**: list of Invoice DTOs (all statuses).

**RBAC**: `admin` + `manager`.

Implementation: calls `@/modules/invoicing` barrel's `listInvoicesByMember(tenantCtx, memberId)`.

---

## 6. Cron — Outbox dispatcher

### 6.1 `POST /api/cron/auto-email-dispatch`

Invoked by Vercel Cron every 1 minute. Also called opportunistically by the `after()` hook on issuance/pay/void/credit-note routes to minimise delivery latency.

**Auth**: `X-Cron-Secret` header matching `env.CRON_SECRET`.
**Behaviour**: drains up to 100 pending outbox rows, dispatches via Resend, marks each `sent` / `bounced` / `permanently_failed` based on response. Emits `auto_email_delivery_failed` audit on permanent failures.

**Response 200**: `{ ok: true, data: { dispatched: 47, bounced: 1, failed: 0 } }`.

---

## 7. DTO shapes (zod schemas — summary)

(Full zod schemas live in `src/modules/invoicing/application/schemas/*.ts` and are generated from Drizzle types with manual UI-field additions.)

### `InvoiceDTO`
```ts
{
  id: string; tenant_id: string; member_id: string;
  plan_year: number; plan_id: string;
  status: 'draft' | 'issued' | 'paid' | 'void' | 'credited' | 'partially_credited';
  draft_by_user_id: string;
  fiscal_year: number | null;
  sequence_number: number | null;
  document_number: string | null;
  issue_date: string | null;          // ISO date
  due_date: string | null;
  paid_at: string | null;
  voided_at: string | null;
  currency: 'THB';
  subtotal_satang: number | null;     // BIGINT → JS Number (safe up to 2^53-1 ≈ 90 trillion THB)
  vat_rate_snapshot: string | null;   // numeric string, e.g. "0.0700"
  vat_satang: number | null;
  total_satang: number | null;
  credited_total_satang: number;
  pro_rate_policy_snapshot: 'none' | 'monthly' | 'daily' | null;
  net_days_snapshot: number | null;
  tenant_identity_snapshot: {/* legal_name_th/en, tax_id, address_th/en, logo_blob_key */} | null;
  member_identity_snapshot: {/* legal_name, tax_id, address, primary_contact_name/email */} | null;
  payment_method: 'bank_transfer' | 'cheque' | 'cash' | 'other' | null;
  payment_reference: string | null;
  payment_notes: string | null;
  payment_recorded_by_user_id: string | null;
  void_reason: string | null;
  voided_by_user_id: string | null;
  pdf_blob_key: string | null;
  pdf_sha256: string | null;
  pdf_template_version: number | null;
  lines: InvoiceLineDTO[];
  created_at: string;
  updated_at: string;
  // Derived (client does not need to compute)
  is_overdue: boolean;
}
```

### `InvoiceLineDTO`
```ts
{
  id: string; tenant_id: string; invoice_id: string;
  kind: 'membership_fee' | 'registration_fee';
  description_th: string; description_en: string;
  unit_price_satang: number;
  quantity: string;                   // numeric 10,4
  pro_rate_factor: string | null;     // numeric 6,4
  total_satang: number;
  position: number;
  created_at: string; updated_at: string;
}
```

### `CreditNoteDTO`
```ts
{
  id: string; tenant_id: string; original_invoice_id: string;
  fiscal_year: number; sequence_number: number; document_number: string;
  issue_date: string; issued_by_user_id: string; reason: string;
  credit_amount_satang: number; vat_satang: number; total_satang: number;
  tenant_identity_snapshot: {/* … */};
  member_identity_snapshot: {/* … */};
  pdf_blob_key: string; pdf_sha256: string; pdf_template_version: number;
  created_at: string; updated_at: string;
}
```

### `TenantInvoiceSettingsDTO`
```ts
{
  id: string; tenant_id: string;
  vat_rate: string;                               // "0.0700"
  registration_fee_satang: number;
  legal_name_th: string; legal_name_en: string;
  tax_id: string;
  registered_address_th: string; registered_address_en: string;
  invoice_number_prefix: string;
  invoice_number_reset_cadence: 'yearly' | 'perpetual';
  receipt_numbering_mode: 'combined' | 'separate';
  credit_note_number_prefix: string;
  fiscal_year_start_month: number;
  default_net_days: number;
  pro_rate_policy: 'none' | 'monthly' | 'daily';
  logo_blob_key: string | null;
  auto_email_enabled: boolean;
  billing_reply_to_email: string | null;      // Reply-To for auto-emails; nullable, falls back to inviting admin email
  billing_from_name: string | null;           // tenant-branded From display name; nullable, falls back to "Chamber-OS Billing"
  tenant_logo_count: number;                  // count of historical logos uploaded (monotonic; capped at 50 per R2-E5)
  created_at: string; updated_at: string;
}
```

## 8. Endpoint → FR traceability

| Endpoint | Serves FR |
|---|---|
| POST /api/invoices | FR-001 (draft create) |
| PATCH /api/invoices/[id] | FR-001 (draft edit) |
| DELETE /api/invoices/[id] | FR-001 (draft delete) |
| POST /api/invoices/[id]/preview | FR-001a (watermarked draft preview) |
| POST /api/invoices/[id]/issue | FR-001, FR-002, FR-003, FR-024, FR-027, FR-035 (overflow guard) |
| POST /api/invoices/[id]/pay | FR-006, FR-007, FR-024 |
| POST /api/invoices/[id]/void | FR-008, FR-015 |
| GET /api/invoices/[id]/pdf | FR-004, FR-016 |
| POST /api/invoices/[id]/resend | FR-025 |
| POST /api/credit-notes | FR-020, FR-021, FR-022, FR-023, FR-024 |
| GET /api/credit-notes/[id]/pdf | FR-004, FR-016 |
| GET /api/tenant-invoice-settings | FR-009 |
| PATCH /api/tenant-invoice-settings | FR-009, FR-010, FR-015 |
| POST /api/tenant-invoice-settings/logo | FR-009, FR-034 (security-hardened logo ingress) |
| GET /api/portal/invoices | FR-014 |
| GET /api/portal/invoices/[id]/pdf | FR-013, FR-014, FR-016 |
| GET /api/members/[memberId]/invoices | FR-032 |
| POST /api/cron/auto-email-dispatch | FR-024, FR-026 |
