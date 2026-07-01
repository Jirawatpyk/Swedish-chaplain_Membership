# Contract — Tenant Invoice Settings (WHT note + seller Head Office/Branch + RC cutover)

**Feature**: `088-invoice-tax-flow-redesign` · **Surface**: `GET` + `PATCH /api/tenant-invoice-settings`
**Use-case**: `updateTenantInvoiceSettings`
**Route handler**: `src/app/api/tenant-invoice-settings/route.ts`
**Covers**: US5 (footer/WHT note), US3 (seller Head Office/Branch), numbering cutover ·
   FR-008, FR-012

---

## Purpose

Extend the tenant invoice-settings PATCH/GET with the fields this redesign needs, threaded into
the immutable `TenantIdentitySnapshot` pinned at issue (never a template literal):

1. **Withholding-tax / footer note** — `wht_note_th` + `wht_note_en` (both `text NULL`). Replaces
   the hardcoded "Rendered by Chamber-OS (§-citation)" footer. `NULL` ⇒ render nothing (a tenant
   that configures no note gets a clean footer). Rendered **only on `invoice_subject='membership'`
   documents** (never event/sponsorship) — the render gate is per-document subject, not a blanket
   tenant flag. TSCC seed text is **แบบ A** (customer wording: TH "หอการค้าไทย-สวีเดนได้รับการ
   ยกเว้นภาษีเงินได้ไม่ต้องหักภาษี ณ ที่จ่าย" / EN "No deduction of withholding tax shall apply, as the income
   is exempt from income tax."), editable, legal **basis ม.65 ทวิ (13) + ท.ป.4/2528**, applied via
   this PATCH (not baked into code). แบบ A is the legally-imprecise "entity-exempt" framing → it is
   an **accountant sign-off item at the Review gate (แบบ A vs the precise แบบ B) BEFORE first
   issuance**.
2. **Seller Head Office / Branch** (§86/4) — `seller_is_head_office boolean NOT NULL DEFAULT true`
   + `seller_branch_code char(5)` (nullable). Default = สำนักงานใหญ่ (`true` / `null`).
3. **Numbering cutover** — existing `receipt_numbering_mode` → `'separate'` and
   `receipt_number_prefix` → `'RC'` (SweCham flip); the bill stream reuses `invoice_number_prefix`
   (`SC`) as the bill prefix.

## Request — `PATCH` (snake_case body, any subset; `bodySchema`, `route.ts:57-100`)

Existing fields unchanged (`vat_rate`, `registration_fee_satang`, `legal_name_*`, `tax_id`,
`registered_address_*`, `invoice_number_prefix`, `credit_note_number_prefix`,
`receipt_number_prefix`, `receipt_numbering_mode` `'separate'` **only** (the `'combined'` reuse
branch is retired/deleted — fail-closed; the flip's only remaining job is the `RC` prefix),
`fiscal_year_start_month`, `default_net_days`, `pro_rate_policy`, `auto_email_enabled`,
`logo_blob_key`). **New fields to add to `bodySchema` + the use-case zod + the port patch +
`copyFields` upsert:**

| field | zod | note |
|---|---|---|
| `wht_note_th` | `string().max(2000).nullable().optional()` | `null` clears |
| `wht_note_en` | `string().max(2000).nullable().optional()` | `null` clears |
| `seller_is_head_office` | `boolean().optional()` | |
| `seller_branch_code` | `string().regex(/^\d{5}$/).nullable().optional()` | 5-digit RD branch code |

Cross-field rule (`.superRefine`): `seller_is_head_office === true` ⇒ `seller_branch_code`
MUST be null; `false` ⇒ code required `/^\d{5}$/`.

**First write bootstraps the row** (unlocks issuance); later writes patch only provided fields.
Rate limit `f4:settings:{tenant}:{actor}` — 30 / min.

## Response

- `PATCH 200`: `{ ok: true }`.
- `GET 200`: `{ settings: { … } | null }` (`null` ⇒ not yet bootstrapped → FR-010 empty state).
  The `settings` object echoes the snake_case shape and MUST add `wht_note_th`, `wht_note_en`,
  `seller_is_head_office`, `seller_branch_code` (thread through `rowToView` L60-67 + the GET
  projection L176-200).

## Preconditions

- Admin session; STD host must resolve to the deployed tenant (dual-bind probe guard).

## Error codes

| code | HTTP | note |
|---|---|---|
| `cross_tenant_forbidden` | 403 | host / deployed-tenant mismatch (audited) |
| `invalid_json` | 400 | |
| `invalid_body` | 400 | zod failure (incl. new branch/pairing rules) |
| `invalid_logo_key` | 400 | logo prefix mismatch |
| `vat_rate_out_of_range` | 400 | |
| `no_op` | 400 | empty patch |
| `server_error` | 500 | |
| `rate_limited` | 429 | 30 / min |

## RBAC

- `PATCH`: `admin` only (`action:'write'`; manager read-only on finance).
- `GET`: `admin` (`action:'read'`); a manager read-only view is a later revision.

## Audit events

- `tenant_invoice_settings_updated` (5y) — every settings mutation (includes WHT note + seller
  branch changes).
- `tenant_receipt_prefix_changed` (10y) — when the `receipt` §87 prefix flips on an active
  tenant (the `RC` prefix cutover triggers this — forensic §87 continuity trail).
- `tenant_invoice_settings_cross_tenant_probe` (5y) — on the dual-bind 403.

## Cutover note

The seeder is `ON CONFLICT DO NOTHING` and the prod settings row already exists, so the flip to
`separate` / `RC` + WHT text + seller branch happens via **this PATCH** (US4 settings form) or a
one-off `UPDATE`, **before the first real document is issued** (operator gate — otherwise the bill
and receipt streams could interleave under the old shared numbering).
