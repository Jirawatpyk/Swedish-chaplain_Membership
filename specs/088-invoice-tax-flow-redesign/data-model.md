# Data Model: Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้)

**Feature**: `088-invoice-tax-flow-redesign` | **Phase**: 1 (design) | **Date**: 2026-07-01
**Inputs**: `spec.md`, `plan.md`, design map `docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md`, tax research `docs/superpowers/specs/2026-06-30-f4-accountant-questions.md`.

This document is **additive** to the shipped F4 data model (`specs/007-invoices-receipts/data-model.md`). It records only the deltas this feature introduces. AS-IS schema referenced at:

- `src/modules/invoicing/infrastructure/db/schema-invoices.ts` (invoices aggregate + CHECKs + partial unique indexes)
- `src/modules/invoicing/infrastructure/db/schema-tenant-document-sequences.ts` (`document_type` enum + counter table)
- `src/modules/invoicing/infrastructure/db/schema-tenant-invoice-settings.ts` (tenant identity + numbering config)
- `src/modules/invoicing/infrastructure/db/schema-credit-notes.ts` (§86/10 aggregate)
- `src/modules/members/infrastructure/db/schema-members.ts` (F3 buyer record)
- `src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts` + `tenant-identity-snapshot.ts` (issue-time snapshot VOs)
- `src/modules/invoicing/infrastructure/adapters/postgres-sequence-allocator.ts` + `application/ports/sequence-allocator-port.ts` (§87 allocator)

**Next free Drizzle migration index: `0230`** (last applied = `0229_broadcasts_audience_deleted_at.sql`). Migration assignment for this feature is in § B.6.

> **Confirmed tax facts driving the model (do not re-litigate):** membership dues = VATable **7%** (ruling กค 0811/พ./2308); **NO withholding** on dues (ม.65 ทวิ (13) + ท.ป.4/2528, ruling กค 0811/8542 — basis is the dues exclusion, not "entity income-tax-exempt"). Branch-line render gate = **VAT-registrant juristic buyer** (NOT `buyerHasTin`). WHT note is scoped to `invoice_subject='membership'` only. §105 RE separate register is the **working default but OPTIONAL** (§87 gap-free is per-series). prod is **test-data only** → no byte-stable re-render constraint.

---

## A. Entities

The redesign does not add a new aggregate table. It **relabels** the pre-payment `'invoice'` PdfDocKind to a non-tax bill in place (D5), **moves** the §87 tax number from issue-time to payment-time, and adds branch/WHT particulars to the identity snapshots + the member + the tenant-settings rows. The five affected entities below are all existing rows/VOs gaining columns or semantics.

### A.1 Bill (ใบแจ้งหนี้ / Invoice) — the non-tax pre-payment document

Not a new table — it is the `invoices` row while `status ∈ {issued}` **before** payment, rendered with `pdf_doc_kind='invoice'` re-titled to ใบแจ้งหนี้/Invoice.

| Attribute | Source column / VO | Notes |
|---|---|---|
| bill number | **NEW** `invoices.bill_document_number_raw` (text) | e.g. `SC-2026-000123`; **non-§87**; allocated at issue from the new `bill` stream (§ D). Disjoint from `sequence_number` / `document_number` so it can never enter `invoices_tenant_fiscal_seq_unique` (SC-003). |
| legal nature | `pdf_doc_kind='invoice'` | NO §86/4 title, NO ต้นฉบับ marker, NO §-citation. Not creditable (US6 / § A.4). |
| issue date | `invoices.issue_date` | Billing date. |
| status | `invoices.status` | `draft → issued`; stays downloadable after payment (FR-015). |
| buyer identity | `member_identity_snapshot` (jsonb) | pinned at issue; gains `buyer_is_head_office` + `buyer_branch_code` (§ C.1). |
| seller identity + WHT note | `tenant_identity_snapshot` (jsonb) | pinned at issue; gains seller branch + WHT-note fields (§ C.2). WHT note rendered on the bill too (membership only). |

**Validation**: a non-draft membership/event bill carries `bill_document_number_raw IS NOT NULL` with `sequence_number IS NULL` and `document_number IS NULL` (amended CHECKs, § B.3). The bill number is **not** in the §87 uniqueness index; it has its own per-tenant partial unique index (§ B.2).

### A.2 Tax Receipt (`receipt_combined`, ใบกำกับภาษี / ใบเสร็จรับเงิน) — the §86/4 + §105ทวิ document

The `invoices` row after payment, with the §86/4 receipt PDF materialised.

| Attribute | Source column / VO | Notes |
|---|---|---|
| tax number (RC) | `invoices.receipt_document_number_raw` (text, existing, `schema-invoices.ts:178`) | e.g. `RC-2026-000045`; **§87 no-gaps**; allocated at **payment** from the `receipt` stream (D7 tax point). |
| legal nature | `pdf_doc_kind='receipt_combined'` | §86/4 title + §105ทวิ; renders **ต้นฉบับ + สำเนา** (two pages, one PDF, one sha) per US2. |
| receipt date | payment date (Asia/Bangkok) | **NOT** the bill's `issue_date` (D7). Fiscal year of the RC allocation derives from the **payment date in Asia/Bangkok** (trap G). |
| PDF artifact | `receipt_pdf_blob_key` / `receipt_pdf_sha256` / `receipt_pdf_status` (existing) | `receipt_pdf_status='rendered'` gates creditability (§ A.4). |
| relationship | 1:1 with the paying `invoices` row | The bill (A.1) and this receipt coexist on the **same** row (bill number in `bill_document_number_raw`, tax number in `receipt_document_number_raw`); both PDFs stay downloadable (FR-015). |

### A.3 §105 Receipt (`receipt_separate`, ใบเสร็จรับเงิน §105) — event-without-TIN, UNCHANGED legal identity

Event attendee with no TIN, paid as-issued. `pdf_doc_kind='receipt_separate'`, `receipt_document_number_raw` on the `RE` stream (or shared `receipt` — see § D). Inherits only the presentation polish (US4); legal identity untouched. Remains **non-creditable** (`receipt_not_creditable` gate).

### A.4 Credit Note (ใบลดหนี้ §86/10)

Existing `credit_notes` table (`schema-credit-notes.ts`) — **no column change**. Semantics change only:

- References the **§86/4 tax receipt** number, not the bill: `original_document_number → receiptDocumentNumberRaw ?? documentNumber.raw`; `original_issue_date → the receipt's (payment) date` (D7).
- Issuable **only after** the tax receipt exists — new precondition `receipt_pdf_status='rendered'` (on top of the existing `paid`/`partially_credited` gate). Crediting an **unpaid ใบแจ้งหนี้** is blocked (no input VAT to reverse).
- Keeps its **own** `credit_note` / `CN` §86/10 numbering stream (does NOT move to payment).
- Annotation ("CREDITED" stamp) re-targets the **receipt blob** (`receipt_pdf_blob_key`, `kind:'receipt_combined'`), not the now-non-tax bill blob.

### A.5 Member (F3 buyer) — branch fields

`members` row (`schema-members.ts`) gains the §86/4 Head-Office / Branch particular for the buyer. **Admin-only** edit (tax-critical, same posture as `tax_id`; not member-self-editable). See § B.4.

| Attribute | Column | Notes |
|---|---|---|
| head-office indicator | **NEW** `members.is_head_office` boolean NOT NULL DEFAULT true | default สำนักงานใหญ่ for all imported members (F1 §106). |
| branch code | **NEW** `members.branch_code` char(5) | 5 digits (`00001`…) when a branch; NULL for head office. |
| VAT-registrant discriminator | existing `members.legal_entity_type` (text, nullable) | render gate: branch line shows only when `legal_entity_type ≠ individual` (VAT-registrant juristic). A natural-person member's 13-digit national ID is a TIN but is **not** a registrant → no branch line. |

### A.6 Tenant Invoice Settings — WHT note, seller branch, numbering

`tenant_invoice_settings` row (`schema-tenant-invoice-settings.ts`) gains the tenant-configurable WHT footer note + the seller's §86/4 Head-Office/Branch. See § B.5.

| Attribute | Column | Notes |
|---|---|---|
| WHT note (TH) | **NEW** `wht_note_th` text NULL | NULL ⇒ render nothing (non-SweCham tenants get no stray text). Rendered on `invoice_subject='membership'` docs only (FR-012). |
| WHT note (EN) | **NEW** `wht_note_en` text NULL | same posture. |
| seller head-office | **NEW** `seller_is_head_office` boolean NOT NULL DEFAULT true | TSCC = สำนักงานใหญ่ (F2). |
| seller branch code | **NEW** `seller_branch_code` char(5) | NULL for head office. |
| bill prefix | existing `invoice_number_prefix` (repurposed) | `SC` — reused as the bill-stream prefix (D1). No new column unless a dedicated `bill_number_prefix` is preferred. |
| receipt mode / prefix | existing `receipt_numbering_mode` + `receipt_number_prefix` | SweCham cutover: `mode='separate'`, `receipt_number_prefix='RC'` (§ D + § E cutover). |

> **Naming reconciliation**: this spec uses the short column names `wht_note_th` / `wht_note_en` (per plan § Storage). The design map § 10 named them `wht_exemption_note_th` / `wht_exemption_note_en`. **Pick `wht_note_th/_en`** and keep it consistent across schema → repo `rowToView`/`copyFields` → port patch → zod → API → form → i18n. The **text is never a template literal** — it rides settings → `TenantIdentitySnapshot` (pinned at issue, immutable per FR-011) → template.

---

## B. DDL changes (exact names / types / constraints)

### B.1 `document_type` enum += `'bill'` (+ optional `'receipt_105'`)

`schema-tenant-document-sequences.ts:13` — AS-IS:

```ts
export const documentTypeEnum = pgEnum('document_type', ['invoice', 'receipt', 'credit_note']);
```

TO-BE (required):

```ts
export const documentTypeEnum = pgEnum('document_type', ['invoice', 'receipt', 'credit_note', 'bill']);
```

Optional D2-split (only if the operator keeps the §105 RE register separate at the DB-stream level rather than sharing the `receipt` stream — see § D):

```ts
// += 'receipt_105'  ← OPTIONAL. Omit if RE shares the `receipt` documentType stream.
```

**4-place enum add** (repo convention, analog of "add-audit-event-type-4-places"):
1. `documentTypeEnum` pgEnum tuple (above).
2. `DocumentTypeCode` union in `application/ports/sequence-allocator-port.ts:11` (`'invoice' | 'receipt' | 'credit_note'` → `+ 'bill'`).
3. Migration `ALTER TYPE document_type ADD VALUE 'bill'`.
4. Allocator / numbering unit + integration tests asserting the `bill` stream.

**Migration ordering constraint**: `ALTER TYPE … ADD VALUE` must land in **its own migration (0230)**, committed before any migration or runtime path uses the new value (`::document_type`) — a PG restriction on using a freshly-added enum value in the same transaction. Do NOT fold the enum-add into the column/CHECK migration.

### B.2 `invoices.bill_document_number_raw` + partial unique index

New nullable column on `invoices` (`schema-invoices.ts`), mirroring `receipt_document_number_raw` (`:178`):

```ts
// Non-§87 bill number (ใบแจ้งหนี้). Allocated at issue from the `bill` stream
// (prefix SC). Disjoint from sequence_number/document_number so it can never
// enter invoices_tenant_fiscal_seq_unique (SC-003). NULL for drafts.
billDocumentNumberRaw: text('bill_document_number_raw'),
```

Partial unique index (per-tenant), mirroring `invoices_tenant_receipt_raw_uniq` (`schema-invoices.ts:319-321`):

```ts
uniqueIndex('invoices_tenant_bill_raw_uniq')
  .on(table.tenantId, table.billDocumentNumberRaw)
  .where(sql`bill_document_number_raw IS NOT NULL`),
```

**Immutability**: `bill_document_number_raw` is written in the same UPDATE that flips `status` draft→issued (OLD.status='draft' → trigger permits), then locked. Add it to the `invoices_enforce_immutability` allow-at-issue / lock-after-non-draft set exactly like `document_number` (see migration 0214 for the pdf_doc_kind precedent). Verify on live Neon.

### B.3 Amended CHECK constraints on `invoices`

Two CHECKs currently gate numbering on a `sequence_number`/`document_number` pair (with an event-only relaxation for the as-paid no-TIN §105 receipt). Both must be widened so (a) an issued bill row (bill number, NULL sequence) passes, and (b) a **membership** `receipt_combined` row carrying `receipt_document_number_raw` + NULL sequence passes.

**`invoices_draft_has_no_number`** (`schema-invoices.ts:279-286`) — AS-IS:

```sql
status = 'draft'
OR sequence_number IS NOT NULL
OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL)
```

TO-BE (add a bill-number leg):

```sql
status = 'draft'
OR sequence_number IS NOT NULL
OR bill_document_number_raw IS NOT NULL                                     -- NEW: issued ใบแจ้งหนี้ (membership + event-with-TIN)
OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL)  -- unchanged: as-paid no-TIN §105
```

**`invoices_non_draft_has_snapshots`** (`schema-invoices.ts:247-273`) — the numbering sub-clause AS-IS is:

```sql
AND (
  (sequence_number IS NOT NULL AND document_number IS NOT NULL)
  OR (invoice_subject = 'event' AND receipt_document_number_raw IS NOT NULL
      AND sequence_number IS NULL AND document_number IS NULL)
)
```

TO-BE — add a **bill-number leg (a)** and **widen the receipt leg (b)** by dropping the `invoice_subject='event'` gate (membership `receipt_combined` now also carries `receipt_document_number_raw` with NULL sequence):

```sql
AND (
  (sequence_number IS NOT NULL AND document_number IS NOT NULL)
  OR (bill_document_number_raw IS NOT NULL
      AND sequence_number IS NULL AND document_number IS NULL)              -- NEW leg (a): issued/paid bill
  OR (receipt_document_number_raw IS NOT NULL
      AND sequence_number IS NULL AND document_number IS NULL)              -- WIDENED leg (b): drop event gate
)
```

> A **paid membership** row legitimately satisfies **both** (a) and (b) — it carries `bill_document_number_raw` (from issue) **and** `receipt_document_number_raw` (from payment), with `sequence_number`/`document_number` NULL throughout. The OR is correct. Every other snapshot/pdf leg (`subtotal_satang`, `member_identity_snapshot`, `pdf_*` triplet, `pro_rate_policy_snapshot IS NOT NULL OR invoice_subject='event'`, `net_days_snapshot`) stays required, unchanged.

Author both CHECK rewrites in the migration as idempotent `DROP CONSTRAINT … ; ADD CONSTRAINT …` DO-blocks (the live pattern from 0203/0208/0212) and mirror the predicates back into the `check()` builders in `schema-invoices.ts` for schema fidelity. `invoices_pdf_doc_kind_valid` and `invoices_non_draft_has_doc_kind` (`:292-302`) are **unchanged** — `'invoice'`/`'receipt_combined'`/`'receipt_separate'` remain the valid set (the bill is a **relabelled** `'invoice'`, D5, so no new pdf_doc_kind value).

### B.4 `members` — buyer branch fields

New columns on `members` (`schema-members.ts`):

```ts
isHeadOffice: boolean('is_head_office').notNull().default(true),
branchCode: char('branch_code', { length: 5 }),
```

Recommended defence-in-depth pairing CHECK (mirrors the snapshot superRefine, § C.1):

```sql
ALTER TABLE members ADD CONSTRAINT members_branch_pairing_ck CHECK (
  (is_head_office = true  AND branch_code IS NULL)
  OR (is_head_office = false AND branch_code ~ '^[0-9]{5}$')
);
```

RLS + FORCE on `members` is unchanged; the two columns inherit the table's existing policies. No index needed (branch is not a filter axis). Admin-only edit wired in the member edit form + route (not member-self-editable).

### B.5 `tenant_invoice_settings` — WHT note + seller branch

New columns on `tenant_invoice_settings` (`schema-tenant-invoice-settings.ts`):

```ts
whtNoteTh: text('wht_note_th'),                                        // NULL ⇒ render nothing
whtNoteEn: text('wht_note_en'),                                        // NULL ⇒ render nothing
sellerIsHeadOffice: boolean('seller_is_head_office').notNull().default(true),
sellerBranchCode: char('seller_branch_code', { length: 5 }),
```

Recommended seller pairing CHECK (mirrors § B.4):

```sql
ALTER TABLE tenant_invoice_settings ADD CONSTRAINT tenant_invoice_settings_seller_branch_ck CHECK (
  (seller_is_head_office = true  AND seller_branch_code IS NULL)
  OR (seller_is_head_office = false AND seller_branch_code ~ '^[0-9]{5}$')
);
```

Thread the four new fields through: schema → `drizzle-tenant-settings-repo` (`rowToView` + upsert `copyFields`) → `TenantSettingsRepoPort` patch → `update-tenant-invoice-settings` zod + patch → API `route.ts` (body / GET / PATCH maps) → settings page → `invoice-settings-form.tsx` (two textareas + seller-branch input) → i18n (EN/TH/SV). SweCham WHT note seeded via the settings form / one-off `UPDATE` (§ E cutover), never a code literal.

### B.6 Migration assignment (from index 0230)

| idx | migration | contents |
|---|---|---|
| `0230` | `document_type_add_bill` | `ALTER TYPE document_type ADD VALUE 'bill'` (+ `'receipt_105'` if D2-split). **Own migration** (enum-add ordering, § B.1). |
| `0231` | `invoices_bill_number_and_checks` | `bill_document_number_raw` column + `invoices_tenant_bill_raw_uniq` partial unique + rewrite `invoices_draft_has_no_number` & `invoices_non_draft_has_snapshots` + extend `invoices_enforce_immutability` for the bill column. |
| `0232` | `members_branch_fields` | `is_head_office` + `branch_code` + `members_branch_pairing_ck`. |
| `0233` | `tenant_invoice_settings_wht_and_seller_branch` | `wht_note_th` + `wht_note_en` + `seller_is_head_office` + `seller_branch_code` + `tenant_invoice_settings_seller_branch_ck`. |

Apply 0230→0233 to the **`dev` Neon branch**, then `pnpm test:integration` **before commit** (repo gotcha: migration + integration before committing schema-referencing code). Prod migrates on Vercel deploy.

---

## C. Snapshot value-object additions

### C.1 `MemberIdentitySnapshot` (buyer) += branch fields

`member-identity-snapshot.ts` — add two fields to the interface + zod schema, following the **exact `.optional().default(...)` + `.superRefine` pairing** posture already used for `member_number` / `member_number_display` (`:96-125`):

> **Third snapshot field added per § F.1** (listed here so § C.1's field set is complete): `buyer_is_vat_registrant: boolean` (`.optional().default(false)`, same posture) is **also** added to this snapshot — it is the actual branch-line render gate (VAT-registrant juristic), populated at issue from `members.legal_entity_type` (`≠ 'individual'` AND non-NULL). The `buyer_is_head_office` / `buyer_branch_code` pair below carries the §86/4 particulars; the line only draws when `buyer_is_vat_registrant` is true. Full definition + fail-closed rule in § F.1.

**Interface** (`MemberIdentitySnapshot`, after `member_number_display`):

```ts
/**
 * §86/4 Head-Office/Branch indicator for the BUYER. `true` = สำนักงานใหญ่;
 * `false` = a branch, with `buyer_branch_code` carrying the 5-digit code.
 * Historical snapshots (key absent) default to head-office (`.optional().default(true)`).
 * Render gate is separate: the branch LINE only shows for a VAT-registrant
 * juristic buyer (legal_entity_type ≠ individual) — a natural-person member
 * carries the default pair but no line is drawn.
 */
readonly buyer_is_head_office: boolean;
readonly buyer_branch_code: string | null;
```

**Zod** (inside `memberIdentitySnapshotSchema`, before the existing `.superRefine`):

```ts
buyer_is_head_office: z.boolean().optional().default(true),
buyer_branch_code: z.string().regex(/^\d{5}$/, 'buyer_branch_code must be 5 digits').nullable().optional().default(null),
```

**Pairing rule** — extend the existing `.superRefine` (or add a second `ctx.addIssue`) so head-office ⇒ code null / branch ⇒ 5-digit code:

```ts
// buyer_is_head_office=true  ⇒ buyer_branch_code MUST be null
// buyer_is_head_office=false ⇒ buyer_branch_code MUST match /^\d{5}$/ (non-null)
if (data.buyer_is_head_office && data.buyer_branch_code !== null) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buyer_branch_code'],
    message: 'head-office buyer must have null branch_code' });
}
if (!data.buyer_is_head_office && data.buyer_branch_code === null) {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['buyer_branch_code'],
    message: 'branch buyer must carry a 5-digit branch_code' });
}
```

Because both defaults run **before** the refine (same as `member_number`), a **historical JSONB snapshot** (keys absent) resolves to `head-office / null` and passes the pairing. `z.object` **strips undeclared keys**, so declaring both on the schema is mandatory (an interface-only add would silently drop the value at write `makeMemberIdentitySnapshot` and read `parseMemberIdentitySnapshot`).

**Adapter wiring**: `member-identity-adapter.ts` — read `is_head_office` + `branch_code` in the `getForIssue` SELECT (~L47-84), write them onto the snapshot (~L152-174). Non-member event buyers (manual buyer object in `create-event-invoice-draft.ts` ~L99-110, 278-284) supply the pair explicitly (default head-office/null).

### C.2 `TenantIdentitySnapshot` (seller) += branch + WHT note fields

`tenant-identity-snapshot.ts` — this VO is a **plain interface + `Object.freeze`** with **no zod runtime guard** (unlike the member snapshot). Add four fields:

```ts
export interface TenantIdentitySnapshot {
  readonly legal_name_th: string;
  readonly legal_name_en: string;
  readonly tax_id: string;
  readonly address_th: string;
  readonly address_en: string;
  readonly logo_blob_key: string | null;
  // 088 — seller §86/4 Head-Office/Branch (pinned at issue, immutable FR-011)
  readonly seller_is_head_office: boolean;
  readonly seller_branch_code: string | null;
  // 088 — tenant-configurable WHT footer note (NULL ⇒ render nothing).
  // Rendered on invoice_subject='membership' documents only.
  readonly wht_note_th: string | null;
  readonly wht_note_en: string | null;
}
```

Because there is no read-boundary zod parse, **historical** tenant snapshots (keys absent) come back with these fields `undefined`. The template MUST guard: `seller_is_head_office ?? true`, `seller_branch_code ?? null`, `wht_note_th ?? null`, `wht_note_en ?? null`. `makeTenantIdentitySnapshot` copies the new fields from `tenant_invoice_settings` at issue. (Optional hardening: introduce a `tenantIdentitySnapshotSchema` zod guard to match the member snapshot's read-boundary rigour — not required by this feature.)

---

## D. Numbering streams

| stream | `document_type` | prefix | §87 no-gaps | allocated at | stored in | reset |
|---|---|---|---|---|---|---|
| **bill (ใบแจ้งหนี้)** | **`bill`** (new) | `SC` (from `invoice_number_prefix`, D1) | **no** — a gap is legal | **issue** (`issue-invoice.ts`) | **`bill_document_number_raw`** | yearly (tidy; not §87-required) |
| **tax receipt (RC)** | `receipt` | `RC` (`receipt_number_prefix`) | **yes** | **payment** (`record-payment.ts` / `issue-event-invoice-as-paid.ts` / `render-receipt-pdf.ts`) | `receipt_document_number_raw` | yearly |
| **§105 plain receipt (RE)** | `receipt_105` (new, D2-split) **or** shared `receipt` | `RE` | yes (own register if split) | payment (as-paid) | `receipt_document_number_raw` | yearly |
| **credit note (CN)** | `credit_note` | `CN` (`credit_note_number_prefix`) | yes | CN issue | `credit_notes.sequence_number`/`document_number` | yearly |

Notes:

- **All streams** share the single allocator `postgresSequenceAllocator.allocateNext(tx, {tenantId, documentType, fiscalYear})` with the per-`(tenant, documentType, fiscalYear)` advisory lock `invoicing:{tenant}:{doc_type}:{fy}` (`postgres-sequence-allocator.ts:70,93`) and the counter table `tenant_document_sequences` (PK `(tenant_id, document_type, fiscal_year)`). Adding the `bill` (and optional `receipt_105`) stream is a **data-only** extension — no allocator code change beyond the `DocumentTypeCode` union.
- **Why a separate `bill_document_number_raw` column (not `document_number`)**: `sequence_number`/`document_number` feed the §87 unique index `invoices_tenant_fiscal_seq_unique` (no stream discriminator). A non-§87 bill number placed there could false-collide with a tax number or falsely satisfy §87 invariants (SC-003). The bill therefore gets its own column + `invoices_tenant_bill_raw_uniq` (§ B.2).
- **RC/RE split is OPTIONAL** (accountant C1; §87 gap-free is per-series). **Default = separate** (`receipt_105`/`RE`) for audit clarity; the simpler **shared `receipt` register** (RC + RE interleaved, still gap-free) is equally §87-valid. The DB supports either — the split only adds an enum value + one stream; the merge needs no new enum value.
- **Fiscal year (trap G)**: the RC allocation at payment derives `fiscalYear` from the **payment date in Asia/Bangkok** (a Dec payment recorded in Jan numbers into the Dec FY) — not `now()`, not the bill's `issue_date`.
- **Hot-path**: every membership payment now takes the `invoicing:{tenant}:receipt:{fy}` advisory lock (combined-mode took no receipt lock before). Payments are low-frequency → acceptable. The overflow-must-throw / no-gap discipline moves **with** the allocation into `record-payment` + `issue-event-invoice-as-paid` (both already throw-in-tx).

---

## E. State transitions

`invoice_status` enum (`schema-invoices.ts:31-38`, unchanged): `draft | issued | paid | void | credited | partially_credited`.

```
                     ┌─────────────────────────────────────────────────────────┐
                     │                                                         (void)
  draft ──issue──▶ issued ──payment──▶ paid ──credit(partial)──▶ partially_credited
   │  (BILL number,   │  (RC §87 number,   │  (§86/4 receipt)         │
   │   non-§87, SC,    │   allocated NOW,    │                        └──credit(full)──▶ credited
   │   pdf_doc_kind    │   payment-dated,    │
   │   ='invoice')     │   Original+Copy)    └──(void)──▶ void
   │                   │
   └──delete-draft─────┘  (any non-terminal state → void by admin)
```

| transition | use-case | §87 allocation | numbering column written | doc / kind |
|---|---|---|---|---|
| `draft → issued` | `issue-invoice.ts` | **none** (bill is non-§87) | `bill_document_number_raw` (SC, `bill` stream) | ใบแจ้งหนี้ / `pdf_doc_kind='invoice'`; NO §86/4, NO ORIGINAL, NO §-citation |
| `issued → paid` | `record-payment.ts` (offline) · `issue-event-invoice-as-paid.ts` (event as-paid) · `render-receipt-pdf.ts` (async worker) · online passthrough (`confirm-payment → invoicing-bridge → markPaidFromProcessor → recordPayment`) | **RC §87 allocated HERE** (tax point = payment, §78/1) | `receipt_document_number_raw` (RC, `receipt` stream) | ใบกำกับภาษี/ใบเสร็จรับเงิน / `receipt_combined`; payment-dated (D7); Original+Copy |
| event-no-TIN as-paid (`draft → paid`) | `issue-event-invoice-as-paid.ts` | §105 allocated at payment (`RE`, own or shared register) | `receipt_document_number_raw` | §105 ใบเสร็จรับเงิน / `receipt_separate` (unchanged identity) |
| `paid → partially_credited` / `credited` | `issue-credit-note.ts` | CN §86/10 allocated at CN issue (unchanged stream) | `credit_notes.sequence_number`/`document_number` (CN) | ใบลดหนี้; references the **RC receipt** (D6); requires `receipt_pdf_status='rendered'` |
| any non-terminal → `void` | void use-case | none | — | bill/receipt voided; void stamp repeats across pages (`fixed`) |

**Where §87 is allocated now**: the §87 no-gaps obligation **moves from issue-time to payment-time**. Previously `issue-invoice.ts` allocated a §87 `invoice` number at issue; now issue allocates only the **non-§87 `bill`** number, and the §87 `RC` number is minted at the `issued → paid` transition. **Steps must land together** (plan): if `issue-invoice` kept allocating a §87 number while `record-payment` also allocates one, every sale would mint **two** tax numbers — the exact duplicate-§86/4 this feature removes.

**Cutover (operator gate, before first real document)**: SweCham `tenant_invoice_settings` flip — `receipt_numbering_mode='separate'`, `receipt_number_prefix='RC'`, seed `wht_note_th`/`wht_note_en` (membership WHT text), set `seller_is_head_office=true` / `seller_branch_code=NULL`. The seeder is `ON CONFLICT DO NOTHING` and the prod row already exists → the flip happens via the settings form (US5) or a one-off `UPDATE`. Imported members default to `is_head_office=true` / `branch_code=NULL`; admin edits only the genuine-branch rows.

**Cutover data-audit — `members.legal_entity_type` (before first issuance).** The buyer branch line (§ F.1) is the VAT-registrant-juristic gate and it **fails closed** on a NULL `legal_entity_type` → a genuine VAT-registrant juristic member whose type was never populated would silently render **no** §86/4 สำนักงานใหญ่ line. Before first issuance, **audit and populate `members.legal_entity_type` for the 131 imported members**: seed the known juristic members to their actual entity type (`≠ 'individual'`), leaving true natural persons at `individual` / NULL. Without this step the fail-closed branch omits the สำนักงานใหญ่ line for real registrants. **E2E assertion:** a member with a populated juristic `legal_entity_type` → the สำนักงานใหญ่ (or branch) line renders on the §86/4 receipt; a member with NULL `legal_entity_type` → **no** branch line is drawn.

---

## F. Critique remediation (2026-07-01)

*Model deltas added after the dual-lens critique (E1/E2, E4/E5, E6, FR-017).*

**F.1 — Buyer VAT-registrant discriminator on the snapshot (E1/E2, blocks the branch gate).** The branch line must gate on VAT-registrant-juristic, but the snapshot carries no such field. Add `buyer_is_vat_registrant: boolean` to `MemberIdentitySnapshot` (+ the tenant-manual-event buyer snapshot), populated **at issue** from `members.legal_entity_type` (`≠ 'individual'` AND non-NULL). Zod: `.optional().default(false)` (same posture as `member_number`; `z.object` strips undeclared keys). **NULL / unknown `legal_entity_type` → `false` → NO branch line (fail-closed)** — never fall back to `buyerHasTin`. The template gates the buyer branch line on `member.buyer_is_vat_registrant`, not on TIN presence.

**F.2 — Async worker inputs (E4/E5).** **Allocation happens in `record-payment` in-tx, never in the worker.** `record-payment.ts` allocates the RC number (§87, `receipt` stream) inside the payment transaction and enqueues the render; the async `render-receipt-pdf` worker only **reads** the already-allocated `receipt_document_number_raw` + `paymentDate` (for dating) — it does **not** allocate. Accordingly, `render-receipt-pdf.ts` and its enqueue payload (`record-payment.ts`) MUST carry `paymentDate` + a **payment-date-derived** `fiscalYear` (Asia/Bangkok), NOT the frozen issue-time `loaded.fiscalYear`. The worker MUST source the tax number from `receipt_document_number_raw` (a membership bill's `document_number` is now NULL), recompute kind via the new `inferReceiptKind` resolver, and null-safe every `documentNumber` deref. Add an integration test: async render on a membership bill with `document_number = NULL`.

**F.3 — Void of an unpaid bill (E6).** `void-invoice.ts` MUST fall back to `bill_document_number_raw` when `document_number` is NULL, and the **default** template title must be the relabeled ใบแจ้งหนี้ so a voided unpaid bill is never re-titled "Tax Invoice" (`voidUnderlyingKind='invoice'` → ใบแจ้งหนี้).

**F.4 — In-flight legacy-bill guard (FR-017 / P8).** The pay path MUST reject a legacy invoice with a §87 `sequence_number` but no `bill_document_number_raw` (issued under the old flow) → force void + re-issue, so the row can never carry two §87 numbers.

**F.5 — Combined-numbering mode RETIRED — always `'separate'` (Decision A, 2026-07-01).** In the new flow the bill carries a **non-§87** `bill_document_number_raw` (SC), so the payment-time §86/4 receipt can **never** reuse a §87 number from the bill. `receipt_numbering_mode` is therefore always `'separate'`; the `combinedMode` number-reuse branch in `record-payment.ts` (which reused `loaded.documentNumber` and wrote NULL to `receipt_document_number_raw`) **MUST be deleted** — reusing a non-§87 bill number as the tax number is a §87 violation. Keep the `receipt_numbering_mode` **column** (no drop), but **`'combined'` is removed from the accepted value set NOW — fail-closed, not deferred**: this feature tightens the CHECK to `'separate'`-only, drops `'combined'` from the settings zod enum, and removes the `'combined'` option from `invoice-settings-form.tsx`, all in this bundle. The settings flip's **only** remaining runtime job is the RC prefix (`receipt_number_prefix='RC'`); any stale text saying the combined branch "stays" is wrong. ⚠️ Distinct concept: the **DOCUMENT** being "combined" (ใบกำกับภาษี/ใบเสร็จรับเงิน merged into one) is the render format and is **unchanged** — only the *numbering* mode collapses to separate.

**F.6 — New audit event `tax_receipt_issued` (SC-001 first-issuance signal).** RC allocation at record-payment fires a **new** audit event `tax_receipt_issued`, **distinct from `invoice_issued`** — it marks the moment a §86/4 tax receipt (RC §87 number) comes into existence and is the **SC-001** first-issuance signal. `tax_receipt_issued` is a **new `audit_event_type` enum value** → the repo **4-place add** (analog of "add-audit-event-type-4-places"): (1) the domain audit-event const/tuple, (2) the `audit_event_type` **pgEnum**, (3) the audit-event **count** test, (4) the audit-event **completeness** test (typecheck does not catch the count-test drift). Retention = **10 years** (Thai RD §87/3 tax-document class, same posture as the F4 backfill), not the 5-year default. Fired **in-tx with the RC allocation** at the record-payment moment on **both** the offline (`record-payment.ts`) and event as-paid (`issue-event-invoice-as-paid.ts`) paths, and therefore on the online passthrough that funnels through `recordPayment`. The subsequent async `render-receipt-pdf` worker (§ F.2) does **not** re-fire it — the event marks allocation, not render.

**F.7 — Offline-payment bank block (FR-022).** `tenant_invoice_settings` gains tenant-configurable **bank / payment-instruction** fields, rendered on the **ใบแจ้งหนี้ ONLY** (never the paid tax receipt) for offline (bank-transfer / cheque) payers. Suggested columns (all `text NULL` → NULL renders nothing, same posture as the WHT note): `bank_payee_name`, `bank_account_no`, `bank_account_type`, `bank_name`, `bank_branch`, `bank_address`, `bank_swift`, `payment_instructions_th` / `_en` — **or** a single free-text `payment_block_th` / `_en` (a modelling choice for the plan; structured is cleaner for PDF layout). Threaded settings → snapshot → template exactly like the WHT note; land in **migration 0233** (the settings migration). The bill also renders an **"Issued by"** (preparer/actor) line + blank **"Received by" / "Date"** signature-stamp fields (layout-only, no stored data). SweCham seed data: see spec § Assumptions (Kasikorn Bank, Emquartier Branch; A/C 005-3-92003-9; SWIFT KASITHBK). *(The tenant-invoice-settings contract + settings form gain these fields — refresh at `/speckit.tasks`.)*
