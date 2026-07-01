# Contract — Tenant Invoice Settings (WHT note + seller Head Office/Branch + RC cutover)

**Feature**: `088-invoice-tax-flow-redesign` · **Surface**: `GET` + `PATCH /api/tenant-invoice-settings`
**Use-case**: `updateTenantInvoiceSettings`
**Route handler**: `src/app/api/tenant-invoice-settings/route.ts`
**Covers**: US5 (footer/WHT note + offline-payment bank block), US3 (seller Head Office/Branch),
   numbering cutover · FR-008, FR-012, FR-022

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
   (`SC`) as the bill prefix. Because this re-points the §87 tax-receipt stream, the prefix / mode
   change is **client-gated behind a confirmation `AlertDialog`** (see § Client form UX) — it is
   NOT an ordinary field save.
4. **Offline-payment bank block** (FR-022) — tenant-configurable bank / payment-instruction fields
   rendered on the **ใบแจ้งหนี้ ONLY** (never the paid §86/4 tax receipt), for bank-transfer /
   cheque payers. **DECIDED = structured columns** (shared decision 3; matches data-model § F.7
   lean — structured is cleaner for PDF layout than one free-text blob): `bank_payee_name`,
   `bank_account_no`, `bank_account_type`, `bank_name`, `bank_branch`, `bank_address`,
   `bank_swift`, plus a **free-text instructions line** `payment_instructions_th` /
   `payment_instructions_en` (TH/EN). All `text NULL` → NULL renders nothing (same posture as the
   WHT note); threaded settings → snapshot → template exactly like the WHT note. The ใบแจ้งหนี้ also
   carries a layout-only **"Issued by"** (preparer) line + blank **"Received by" / "Date"**
   signature-stamp fields (no stored data).

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
| `bank_payee_name` | `string().max(200).nullable().optional()` | account / payee name (FR-022) |
| `bank_account_no` | `string().regex(/^[\d\s-]{4,35}$/).nullable().optional()` | digits + dashes/spaces, e.g. `005-3-92003-9` |
| `bank_account_type` | `string().max(50).nullable().optional()` | savings / current (ออมทรัพย์ / กระแสรายวัน) |
| `bank_name` | `string().max(120).nullable().optional()` | e.g. Kasikorn Bank |
| `bank_branch` | `string().max(120).nullable().optional()` | e.g. Emquartier |
| `bank_address` | `string().max(300).nullable().optional()` | branch address |
| `bank_swift` | `string().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/).nullable().optional()` | SWIFT/BIC, 8 or 11 chars, e.g. `KASITHBK` |
| `payment_instructions_th` | `string().max(1000).nullable().optional()` | free-text line (TH) — `null` clears |
| `payment_instructions_en` | `string().max(1000).nullable().optional()` | free-text line (EN) — `null` clears |

Cross-field rule (`.superRefine`): `seller_is_head_office === true` ⇒ `seller_branch_code`
MUST be null; `false` ⇒ code required `/^\d{5}$/`. The bank-block fields are independent (any
subset; `null` clears each); see § Client form UX for the inline SWIFT / account-no format
validation, help text, and char counters.

**First write bootstraps the row** (unlocks issuance); later writes patch only provided fields.
Rate limit `f4:settings:{tenant}:{actor}` — 30 / min.

## Response

- `PATCH 200`: `{ ok: true }`.
- `GET 200`: `{ settings: { … } | null }`. `null` ⇒ the tenant row is **not yet bootstrapped**
  → the settings form renders its **bootstrap empty-state** (the first PATCH creates the row and
  unlocks issuance). *(This is the settings-form empty state; it is NOT governed by an FR — in
  particular do NOT cite FR-010, which specifies the buyer-identity block ORDER on the document,
  not any empty state.)* Separately, a **null `wht_note_th`/`wht_note_en`** renders a **clean
  footer** (no WHT note) per FR-012, and a null bank block renders no payment block on the
  ใบแจ้งหนี้. The `settings` object echoes the snake_case shape and MUST add `wht_note_th`,
  `wht_note_en`, `seller_is_head_office`, `seller_branch_code`, and the bank-block fields
  (`bank_payee_name`, `bank_account_no`, `bank_account_type`, `bank_name`, `bank_branch`,
  `bank_address`, `bank_swift`, `payment_instructions_th`, `payment_instructions_en`) — thread
  through `rowToView` L60-67 + the GET projection L176-200.

## Preconditions

- Admin session; STD host must resolve to the deployed tenant (dual-bind probe guard).

## Error codes

| code | HTTP | note |
|---|---|---|
| `cross_tenant_forbidden` | 403 | host / deployed-tenant mismatch (audited) |
| `invalid_json` | 400 | |
| `invalid_body` | 400 | zod failure (incl. new branch/pairing rules + bank-block SWIFT/account-no format) |
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
  branch + bank-block changes).
- `tenant_receipt_prefix_changed` (10y) — when the `receipt` §87 prefix flips on an active
  tenant (the `RC` prefix cutover triggers this — forensic §87 continuity trail).
- `tenant_invoice_settings_cross_tenant_probe` (5y) — on the dual-bind 403.

## Client form UX (US5 settings form — `invoice-settings-form.tsx`)

Every string introduced below is **new interactive copy** and MUST ship **EN/TH/SV** keys
(Constitution V; TH is mandatory on tax surfaces — shared decision 4). Any status/confirmation
copy is **text** (text-badges / labelled text, never colour-only) for WCAG 1.4.1. The whole
settings form is a **new/extended surface** and MUST pass an explicit **axe-core WCAG 2.1 AA
`@a11y`** assertion — keyboard + focus order, labelled inputs, and `aria-live` on the confirm /
toast reveals — not just a generic e2e pass (shared decision 5).

### Prefix-flip confirmation (MED) — AlertDialog, not a plain save

Changing the **receipt prefix** (`receipt_number_prefix`, e.g. → `RC`) or `receipt_numbering_mode`
is **not** an ordinary field save. Because it re-points the **§87 tax-receipt numbering stream**
(SC-003 continuity), the form MUST interpose a **confirmation `AlertDialog`** that **explains the
§87 continuity impact** ("this changes the sequential §87 tax-receipt numbering stream — do this
only before the first real document of the period is issued; interleaving the old shared numbering
with the new stream breaks §87 no-gaps") **before** the PATCH is sent. On **confirm + `200`** show a
**success toast**; **Cancel** aborts with no write. This same PATCH additionally emits
`tenant_receipt_prefix_changed` (10y) — see § Audit events.

**Ordinary field saves** — WHT note, seller Head Office/Branch, the bank block, net-days, etc. —
show a plain **save toast** with **no** AlertDialog (only the prefix / numbering-mode change is
gated). Reconcile any ambiguity to: **prefix/mode ⇒ AlertDialog + success toast; everything else ⇒
save toast**.

### Bank block — structured fields (MED, DECIDED = structured)

Render the FR-022 bank block as the **structured inputs** (NOT one free-text blob — shared decision
3 / data-model § F.7 lean), each with a localised label + help text:

| field | input | inline validation | help text |
|---|---|---|---|
| `bank_payee_name` | text | ≤200 | account / payee name |
| `bank_account_no` | text | `^[\d\s-]{4,35}$` (digits + dashes/spaces) | e.g. `005-3-92003-9` |
| `bank_account_type` | text | ≤50 | savings / current (ออมทรัพย์ / กระแสรายวัน) |
| `bank_name` | text | ≤120 | e.g. Kasikorn Bank |
| `bank_branch` | text | ≤120 | e.g. Emquartier |
| `bank_address` | text | ≤300 | branch address |
| `bank_swift` | text | SWIFT/BIC `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$` (8 or 11) | e.g. `KASITHBK` |
| `payment_instructions_th` / `_en` | textarea | ≤1000 | free-text line ("Account Payee Only"; payer bears all bank fees) |

- **Format validation is inline / client-side before submit** — SWIFT pattern + account-no
  character class — surfaced with `aria-invalid` + `aria-describedby` + `role=alert`, localised
  **EN/TH/SV**; the server `invalid_body` (zod) is defense-in-depth behind it.
- **Char counters** on the free-text `payment_instructions_*` textareas (and the longer text
  fields) so the admin sees the remaining budget.
- Every label / help / counter / error string carries **EN/TH/SV** keys.

## Cutover note

The seeder is `ON CONFLICT DO NOTHING` and the prod settings row already exists, so the flip to
`separate` / `RC` + WHT text + seller branch happens via **this PATCH** (US4 settings form) or a
one-off `UPDATE`, **before the first real document is issued** (operator gate — otherwise the bill
and receipt streams could interleave under the old shared numbering).
