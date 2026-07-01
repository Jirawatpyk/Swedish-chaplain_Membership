# F4 Invoice / Receipt — Tax-Flow Redesign (bill → ใบแจ้งหนี้)

**Date:** 2026-06-30
**Status:** DESIGN (pending product-owner approval + accountant/RD sign-off)
**Author:** Chamber-OS team (via F4 surface-mapping workflow)
**Affects:** `src/modules/invoicing/**`, `src/modules/members/**` (1 column), `src/modules/payments/**` (passthrough only), tenant settings, i18n, ~25 test files.

> Provenance: this design consolidates an 8-surface read-only map of the live F4 module
> (workflows `wl5fv739h` + `wz7wt0ati`, 2026-06-30). File:line references are AS-IS at that
> commit.

---

## 1. Context & Problem

The customer (TSCC / SweCham) reviewed the live F4 documents and asked for changes. Behind the
cosmetic asks sits a **structural tax-flow correction**:

Today the **pre-payment bill** is issued as a **§86/4 ใบกำกับภาษี / Tax Invoice** (PdfDocKind
`'invoice'`, with a `ต้นฉบับ/ORIGINAL` marker and a §86/4 footer citation), and at payment a
**second** §86/4 document (`receipt_combined`, ใบกำกับภาษี/ใบเสร็จรับเงิน) is issued. For a
**service** (membership / event fee) the VAT tax point (§78/1) is at **payment**, so issuing a
§86/4 tax invoice at billing is premature and produces a **duplicate §86/4** for every sale.

**New model (the correct Thai service-VAT flow):**

| stage | document | legal nature |
|---|---|---|
| billing (before payment) | **ใบแจ้งหนี้ / Invoice** | NON-tax bill (no §86/4, no ORIGINAL marker, no §-citation) |
| payment | **ใบกำกับภาษี / ใบเสร็จรับเงิน** (`receipt_combined`) | the single §86/4 + §105ทวิ tax document — Original **and** Copy |

This resolves the open "tax-point / RD numbering-stream" operator question carried from the F6
§105 work (`docs/...event-invoice-105...` follow-ups).

---

## 2. Scope — three document flows

| flow | billing (ใบแจ้งหนี้) | payment | notes |
|---|---|---|---|
| **membership** (any TIN) | ใบแจ้งหนี้ | ใบกำกับภาษี/ใบเสร็จ (`receipt_combined`, §86/4 — TIN line hidden if absent, per 066) | core |
| **event + TIN** | ใบแจ้งหนี้ (bill-first, paid via system) **or** as-paid | ใบกำกับภาษี/ใบเสร็จ (`receipt_combined`) | shares the `'invoice'` kind with membership |
| **event + no TIN** | — (as-paid only) | **ใบเสร็จรับเงิน §105** (`receipt_separate`) — UNCHANGED | `event_no_tin_requires_paid_issue` already blocks bill-first |

The **presentation** changes (§7) apply to **all** kinds via the single shared template
(`invoice-template.tsx`). The **structural** changes (relabel, §87-move) apply to the
`'invoice'` (bill) and `receipt_combined` kinds. Event-no-TIN §105 keeps its legal identity and
only inherits the cosmetic polish.

---

## 3. Locked decisions

Confirmed with the product owner (defaulting to recommendations on 2026-06-30) + refined by the
deep numbering/credit-note maps:

| # | decision | choice |
|---|---|---|
| D1 | bill (ใบแจ้งหนี้) numbering prefix | keep **`SC`** (repurpose `invoice_number_prefix` as the bill prefix) |
| D2 | event-no-TIN §105 receipt prefix | **`RE`**, on its **own** register (keep the §86/4 `RC` register gap-free — see §6) |
| D3 | footer | drop the §-citation on **all** kinds, replace with a **tenant-configurable WHT-exemption note** |
| D4 | Original + Copy | **two pages in one PDF** (page 1 `ต้นฉบับ/ORIGINAL`, page 2 `สำเนา/COPY`) — one blob, one sha |
| D5 | relabel vs new kind | **relabel `'invoice'` in place** to ใบแจ้งหนี้ (no new PdfDocKind, no `pdf_doc_kind` enum migration) |
| D6 | credit-note target | a §86/10 ใบลดหนี้ references the **`receipt_combined`** (the real §86/4), not the bill |
| D7 | receipt date | the `receipt_combined` is dated at the **payment date** (tax point), not the bill's issue date |

> **D2 refinement note:** the deeper numbering map showed that membership combined receipts and
> event-no-TIN §105 receipts currently **share** the `documentType:'receipt'` stream. To keep the
> §86/4 `RC` register strictly gap-free (a §87 cleanliness argument), §105 plain receipts get their
> **own** stream/prefix (`RE`). This is the conservative, audit-friendly reading and **must be
> confirmed by the accountant/RD** (§12). The simpler alternative — one shared `RC` register for
> all receipts — is legally defensible too; flagged as an open item.

---

## 4. Architecture overview

```
ISSUE (billing)                         PAYMENT (offline record OR online Stripe)
─────────────                           ─────────────────────────────────────────
issue-invoice.ts                        record-payment.ts  /  issue-event-invoice-as-paid.ts
  • allocate BILL number (non-§87)        • allocate §87 RC number (tax point = now)
    documentType:'bill', prefix 'SC'        documentType:'receipt', prefix 'RC'
  • pdfDocKind 'invoice' = ใบแจ้งหนี้       • render receipt_combined (Original + Copy)
  • NO §86/4, NO ORIGINAL marker            • dated at PAYMENT date (D7)
  • renders ใบแจ้งหนี้ / Invoice            • event-no-TIN → §105 RE stream (unchanged kind)
```

The §87 no-gaps obligation **moves from issue-time to payment-time**. The online (Stripe) path
inherits this automatically — `confirm-payment → invoicing-bridge → markPaidFromProcessor →
recordPayment` carry **no** receipt/numbering logic of their own (verified).

---

## 5. Document kinds & PDF template (`invoice-template.tsx`)

1. **Relabel `'invoice'`** (and `'invoice_preview'`) title default → `titleTh='ใบแจ้งหนี้'`,
   `titleEn='Invoice'` (today `'ใบกำกับภาษี'/'Tax Invoice'`, L196-221). `receipt_combined`,
   `receipt_separate`, `credit_note` branches unchanged.
2. **Original marker kind-aware** (L225): `'invoice'`/`'invoice_preview'` → `null` (a ใบแจ้งหนี้
   carries no ต้นฉบับ marker). `receipt_separate` + `credit_note` keep single Original.
3. **`receipt_combined` → Original + Copy** (D4): refactor the single `<Page>` body (L242-464)
   into a reusable page-render fn taking a `copyMarker`; emit **two `<Page>`** in one `<Document>`
   (page 1 `ต้นฉบับ/ORIGINAL`, page 2 `สำเนา/COPY`). One PDF / one sha / port unchanged. The void
   stamp already uses `fixed` so it repeats across pages.
4. **Footer** (L461-463): replace `Rendered by Chamber-OS ({citation})` with the
   tenant-configurable WHT note (from `TenantIdentitySnapshot`, §10). **Retire** the §-citation
   machinery (`revenue-code-citation.ts`, `KIND_AWARE_CITATION_MIN_VERSION`, the `footerCitation`
   branch L233-236). Legal §-identity now rests on the **title** alone (accountant sign-off, §12).
5. **Presentation (all kinds):**
   - thousands-separator commas in `formatThbSatang` (L169-173) — **locale-independent** grouping
     (do **not** use `toLocaleString`; determinism). Ripples to L396/397/405/411/418/454.
   - capitalize first letter of the English amount-in-words — centralize in `amount-to-english.ts`
     (handle `'zero'`), so all kinds inherit it.
   - reorder buyer block (L320-361): **Name → Address → Tax ID → Head Office/Branch** → (then
     Member No., Contact).
   - add §86/4 **`สำนักงานใหญ่ / Head Office | สาขาที่ NNNNN / Branch`** line to **seller**
     (L287-293) and **buyer** blocks (§9).
   - membership line description carries plan name + period, e.g.
     `Swecham Premium Corporate Membership fee 2026 / Period: Jan–Dec 2026`
     (`create-invoice-draft.ts:228-235` — needs plan display name + period dates).
6. **Template version** → bump `CURRENT_TEMPLATE_VERSION` to 4; delete the v1/v2
   byte-stable-preservation gate (prod is test-data only — no SC-003 constraint).

---

## 6. Numbering architecture (§87)

**Today:** ONE gap-free allocator `allocateNext(tx, {tenantId, documentType, fiscalYear})`
(`postgres-sequence-allocator.ts:37-129`), advisory lock `invoicing:{tenant}:{doc_type}:{fy}`.
`documentType` pgEnum = `['invoice','receipt','credit_note']`. The §87 `invoice` number is
allocated **at issue** (`issue-invoice.ts:394-410`) into `invoices.sequence_number` +
`document_number`. Combined-mode receipts **reuse** that number; separate-mode allocates a
`'receipt'` number into `receipt_document_number_raw`.

**New streams:**

| stream | documentType | prefix | §87 no-gaps | allocated at | stored in |
|---|---|---|---|---|---|
| bill (ใบแจ้งหนี้) | **`bill`** (new enum value) | `SC` | no | issue | **new `bill_document_number_raw`** |
| tax receipt (RC) | `receipt` | `RC` | **yes** | payment | `receipt_document_number_raw` |
| §105 plain receipt (RE) | **`receipt_105`** (new) or shared `receipt` | `RE` | yes (own register) | payment (as-paid) | `receipt_document_number_raw` |
| credit note | `credit_note` | `CN` | yes | CN issue | (CN table) |

**Why a new `bill` column, not reuse `document_number`:** `sequence_number` feeds the §87 unique
index `invoices_tenant_fiscal_seq_unique` (no stream discriminator) — a non-§87 bill number in
`sequence_number` would be indistinguishable from a tax number and could false-collide. So the
bill gets its **own** nullable column + a partial unique `(tenant_id, bill_document_number_raw)
WHERE NOT NULL` (mirrors `invoices_tenant_receipt_raw_uniq`).

**DB CHECK constraints to amend** (`schema-invoices.ts`):
- `invoices_draft_has_no_number` (L279-286): accept a non-draft membership row whose number is in
  `bill_document_number_raw` (sequence_number NULL).
- `invoices_non_draft_has_snapshots` (L247-273): add legs for (a) `bill_document_number_raw NOT
  NULL AND sequence_number NULL AND document_number NULL`; (b) widen the receipt-number leg
  (currently gated `invoice_subject='event'`) so **membership** `receipt_combined` rows (now
  carrying `receipt_document_number_raw`, NULL sequence) also pass.
- `documentTypeEnum` += `'bill'` (+ `'receipt_105'` if D2-split) — 4-place enum add per repo
  convention (`docs ... add_audit_event_type_4_places` analog).

**Hot-path note:** every membership payment now takes the `invoicing:{tenant}:receipt:{fy}`
advisory lock (today combined-mode took no receipt lock). Payments are low-frequency → acceptable.
The "overflow-must-throw / no §87 gap" discipline moves with the allocation into `record-payment` +
`issue-event-invoice-as-paid` (already throw-in-tx there).

---

## 7. Payment → receipt path (`record-payment.ts`, `issue-event-invoice-as-paid.ts`)

- `record-payment.ts`: the `receipt_combined` path must **stop reusing** `loaded.documentNumber`
  and always `allocateNext({documentType:'receipt'})` with prefix `RC`, writing
  `receipt_document_number_raw`. Retire the `combinedMode` reuse branch (L493-494, 590, 644-658)
  — with SweCham flipped to `receiptNumberingMode='separate'` the `!combinedMode` allocate-RC
  branch already does the right thing.
- **Receipt date = payment date (D7):** today the receipt renders with `issueDate:
  loaded.issueDate` (the bill's date, `record-payment.ts:591`). The §86/4 tax point is **payment**
  → render with the payment date.
- `issue-event-invoice-as-paid.ts:435-454`: the TIN arm switches from `{documentType:'invoice'}` to
  `{documentType:'receipt', prefix:'RC'}` (receipt_stream numbering shape). No-TIN arm → §105 `RE`
  stream (unchanged kind, D2).
- `render-receipt-pdf.ts` (async/online worker): L181 currently keys `combinedMode` on
  `receiptNumberingMode==='combined'` **only** — must recompute the receipt **kind** from
  `loaded.invoiceSubject` + buyer TIN (a shared Domain helper in `document-kind.ts`), else every
  membership receipt on the live async path renders as §105-only and loses the §86/4 identity.
  **Both** sync (`record-payment`) and async (`render-receipt-pdf`) paths must be fixed identically;
  `FEATURE_F5_ASYNC_RECEIPT_PDF` decides which is live.
- Bridge/Stripe layers (`mark-paid-from-processor`, `invoicing-bridge`, `confirm-payment`) stay
  pure passthrough → the online path inherits the new behavior for free.

---

## 8. Credit notes (§86/10) — target the receipt

- The CN must reference the **§86/4 receipt number**, not the bill:
  `originalDocumentNumber → loaded.receiptDocumentNumberRaw ?? loaded.documentNumber.raw`
  (`issue-credit-note.ts:472-473, 507-511`), and `originalIssueDate` → the **receipt's** date (D7).
- **Re-target the credited annotation (J2)** to the receipt blob (`loaded.receiptPdf.blobKey`,
  `kind:'receipt_combined'`), **not** `loaded.pdf.blobKey` (now the non-tax ใบแจ้งหนี้). Persist via
  a new `applyReceiptPdfRegeneration` (updates `receipt_pdf_sha256`) rather than
  `applyInvoicePdfRegeneration`. The J2 re-render must reproduce the **Original+Copy** layout.
- **Creditability precondition becomes "has a rendered §86/4 receipt":** the existing
  `paid`/`partially_credited` gate already implies this, but add an explicit guard on
  `receiptPdfStatus === 'rendered'` so a CN can never reference a receipt that hasn't materialized
  (async-pending / failed). Crediting an **unpaid ใบแจ้งหนี้** is now (correctly) blocked — it is a
  non-tax document with no input VAT to reverse.
- Keep the `receipt_not_creditable` gate (event-no-TIN §105 stays non-creditable). Keep the CN's
  own `credit_note`/`CN` §86/10 stream (does NOT move to payment). `cnRefBlock` label
  `อ้างอิงใบกำกับภาษีต้นฉบับ` stays valid (still points at the §86/4); only its value changes.
- Reconsider dropping `'invoice'` from `isCreditAnnotatable` (L194-195) so the non-tax ใบแจ้งหนี้
  never carries a §86/4-style CREDITED tax stamp.
- `drizzle-credit-note-repo.ts:388` `listPaged` projection → surface the RC receipt number.

---

## 9. Party data model — §86/4 Head Office / Branch

§86/4 requires a **head-office vs branch** indicator for both registrant parties. It is **entirely
absent** today (no field on `MemberIdentitySnapshot`, `TenantIdentitySnapshot`, the F3 `members`
table, or `tenant_invoice_settings`).

- **Seller** (`tenant_invoice_settings` → `TenantIdentitySnapshot`): add
  `seller_is_head_office boolean NOT NULL DEFAULT true` + `seller_branch_code char(5)` (nullable).
- **Buyer (F3 member)** (`members` table → `MemberIdentitySnapshot`): add
  `is_head_office boolean NOT NULL DEFAULT true` + `branch_code char(5)`. Read in
  `member-identity-adapter.ts:getForIssue` SELECT (L47-84), write onto the snapshot (L152-174).
  **Admin-only** edit (tax-critical, like `tax_id`; not member-self-editable).
- **Buyer (non-member event)**: extend the manual buyer object in `create-event-invoice-draft.ts`
  (L99-110, 278-284).
- **Snapshot zod (additive):** add `buyer_is_head_office` + `buyer_branch_code` with the
  `.optional().default(...)` posture used by `member_number`, + a `.superRefine` pairing rule
  (head-office ⇒ code null; branch ⇒ `/^\d{5}$/`). Historical JSONB snapshots default to
  "head office / null".
- **Render:** seller always shows `สำนักงานใหญ่` or `สาขาที่ {code}`. Buyer branch line gated on
  the buyer being a **VAT-registrant juristic person** — **NOT** merely `buyerHasTin(...)`.
  ⚠️ Tax-auditor catch (2026-06-30): a natural-person member's 13-digit national ID is usable AS a
  TIN but they are NOT a VAT registrant and have no head office/branch — gating on `buyerHasTin`
  would render a nonsensical `สำนักงานใหญ่` for an individual. Use a `buyerIsVatRegistrant` /
  juristic discriminator (e.g. derived from `legalEntityType` ≠ individual), the same axis on which
  the buyer TIN itself is §86/4-mandatory.

---

## 10. Tenant settings + WHT footer (multi-tenant)

`tenant_invoice_settings` migration (next free index after 0229):
- `wht_exemption_note_th text NULL` + `wht_exemption_note_en text NULL` (NULL ⇒ render nothing, so
  non-SweCham tenants get no stray text). **The TSCC WHT text is NEVER a template literal** — it
  rides settings → `TenantIdentitySnapshot` (pinned at issue, immutable per FR-011) → template.
- `seller_is_head_office` + `seller_branch_code` (§9).
- (optional) a dedicated `bill_number_prefix`, else repurpose `invoice_number_prefix` as the bill
  prefix.
- SweCham config flip: `receiptNumberingMode='separate'`, `receiptNumberPrefix='RC'`.

Thread the new fields through: schema → `drizzle-tenant-settings-repo` (rowToView L60-67 + upsert
copyFields L220-238) → `tenant-settings-repo` port patch → `update-tenant-invoice-settings` zod +
patch → API `route.ts` (body/GET/PATCH maps) → settings page → `invoice-settings-form.tsx`
(textareas + branch input) → i18n. **Default WHT text** seeded:
`** No withholding tax is applicable, as the income is exempt from income tax. ** หอการค้าไทย-สวีเดนได้รับการยกเว้นภาษีเงินได้ไม่ต้องหักภาษี ณ ที่จ่าย`
(note the source text's `ภาษาเงินได้/หักภาษา` are typos → `ภาษีเงินได้/หักภาษี`).

> ⚠️ **Tax-auditor catch (2026-06-30) — WHT note is BLOCKING, reword + re-scope before use:**
> (a) The wording conflates **entity income-tax status** with **payment-type WHT obligation** — WHT
> (§3เตรส/§50, ท.ป.4/2528) triggers on the TYPE of income paid, not solely on recipient status. The
> correct basis is "ค่าบำรุงสมาชิกหอการค้าฯ อยู่นอกฐาน/ไม่ใช่เงินได้ประเภทที่ต้องหัก" tied to **หอการค้า
> status under พ.ร.บ.หอการค้า พ.ศ. 2509**, NOT a blanket "entity exempt".
> (b) There is an unreconciled **tension**: if membership is a VATable ค่าบริการ (7% §86/4), why not
> 3% WHT under ท.ป.4 ข้อ 12/8? The resolution rests on the chamber-status exclusion — must be stated.
> (c) **Scope the note to `invoice_subject='membership'` ONLY**, not a per-tenant blanket on every
> document. Event-fee / sponsorship / advertising receipts may be **taxable commercial income the
> payer DOES withhold on** — printing the exemption note there mis-advises. ⇒ render gate = per-doc
> subject (membership), and **confirm TSCC's legal form + RD status/ruling** with the accountant.
>
> ✅ **RD web research (2026-07-01) — law resolved (HIGH confidence, primary rd.go.th rulings):**
> membership dues = **VATable 7%** (ruling **กค 0811/พ./2308**, a หอการค้า case, rd.go.th/25136.html)
> AND **no withholding** for the corporate payer, basis **ม.65 ทวิ (13) + ท.ป.4/2528** (ruling **กค
> 0811/8542**, rd.go.th/25308.html) — NOT "entity income-tax-exempt". Correct note wording lives in
> the accountant-questions doc (แบบ B). WHT note is a **tenant-settings text field** (editable). The
> accountant confirms only 3 FACTS: (1) TSCC is VAT-registered; (2) no fee tier is volume-based (else
> ม.40(8) → withhold); (3) note scoped to `invoice_subject='membership'`. Full cited brief: workflow
> `ws4uk6w5w`.

**Cutover:** the seeder is `ON CONFLICT DO NOTHING` and the prod row already exists → the flip to
`separate`/`RC` + WHT text happens via the settings form (US4) or a one-off `UPDATE`, **before the
first real document is issued** (operator gate).

---

## 11. i18n & UI labels (rename-hazard zone)

Change i18n **values in place** (keep key names → no `MISSING_MESSAGE`) so no surface calls the bill
ใบกำกับภาษี/Tax Invoice. Confirmed offenders (mostly TH; EN largely already "Invoice"):
`invoices.list.actions.download` (th 1726) + `downloadInvoiceAria` (en 1728/th 1728);
`invoices.detail.actions.download` (th 1971) + aria (en/th 1982); `invoices.detail.toast.invoice*`
(th 1998-2000); `portal.invoices.actions.download` (th 4287) + aria (en/th 4288) + portal toasts;
`invoices.list.description` (en/th/sv 1721); the `docType` chip block (en/th/sv 1877-1885, consumed
by `event-fee-form.tsx:1121-1129`) — bill-first event+TIN must show ใบแจ้งหนี้/Invoice;
issue-dialog copy (`invoices.issue.*` 2078/2086/2087, delete-draft 2126, event hint 1918) — issuing
the bill no longer allocates a §87 number. Add new `สำนักงานใหญ่/สาขา` + WHT-note labels in all
three locales.

---

## 12. Open questions — accountant / RD sign-off (BLOCKING before ship)

This redesign is tax-law-sensitive. Route through the `thai-tax-compliance-auditor` agent **and** a
real accountant before shipping:

1. **§105 register split (D2) — OPTIONAL, not required.** Tax-auditor correction (2026-06-30): §87
   gap-free is **per-series**, not a duty to maintain a §86/4-only register. RC (combined §86/4) and
   RE (§105 plain no-TIN event) BOTH carry 7% output VAT and feed รายงานภาษีขาย/ภ.พ.30, so ONE
   mixed-but-gap-free `receipt` register satisfies §87 (matches the existing β-numbering ruling).
   Separate RC/RE is the **tidier/conservative OPTION** (audit clarity), the simpler shared register
   is equally valid. Pick on operational preference — recommend separate for clarity, but it does NOT
   block.
2. **Footer §-citation removal (D3):** confirm the legal §-identity may rest on the **title** alone
   (no §-citation line), and that the WHT note may replace it on all kinds.
3. **Tax-point / receipt date (D7):** confirm the §86/4 tax point is the **payment date** and the
   receipt is dated accordingly (not the bill's issue date).
4. **Credit-note timing:** confirm a §86/10 ใบลดหนี้ is issuable **only after** the §86/4 receipt
   exists (unpaid-bill credit is blocked) — a behavior change from "credit an issued invoice".
5. **Buyer branch default:** when a registrant buyer's branch is unknown, default to **สำนักงานใหญ่**
   (pragmatic) vs require explicit admin input before a §86/4 receipt can issue?
6. **WHT note (BLOCKING) — confirm legal basis + scope to membership.** See §10 tax-auditor catch:
   confirm TSCC's legal form + RD status (พ.ร.บ.หอการค้า 2509), reword to the correct basis
   ("ค่าบำรุงสมาชิก…อยู่นอกฐาน WHT"), and render the note ONLY on `invoice_subject='membership'`
   documents (NOT event/sponsorship). Head Office/Branch line on the non-tax ใบแจ้งหนี้ = harmless
   consistency (data is the same snapshot); render on all is fine.
7. **Bill numbering cadence:** does the non-§87 ใบแจ้งหนี้ need yearly-reset + gap-free numbering
   (tidy) or is a loose counter acceptable (it carries no §87 obligation)?

---

## 13. Testing impact (~25 files)

No stored binary goldens — every "golden" renders real PDF bytes + asserts text, so "regeneration"
= editing asserted strings/kinds, **on live Neon** (apply migration → `pnpm test:integration`
before commit). Hardest hits:
- **HARD break:** `revenue-code-citation.test.ts`, `footer-citation-golden.test.ts`,
  `event-invoice-pdf-golden.test.ts` (event+TIN + membership assert "Tax Invoice"),
  `e2e/invoice-draft-issue.spec.ts` AS3 (issued bill asserts `ใบกำกับภาษี`/`Tax Invoice`),
  `seq-interleaved-membership-event.test.ts` (the §87-at-issue encoder),
  `issue-invoice.test.ts` (`allocateNext documentType:'invoice'` at issue),
  `record-payment.test.ts` (combined→no-seq / separate→receipt_separate at payment),
  `issue-as-paid.test.ts` (invoice-stream EVT/EVD numbering).
- **New coverage needed:** §87 RC stream gap-free across mixed membership + event payments; bill
  number never enters `invoices_tenant_fiscal_seq_unique`; the membership `/pay` route mints a
  §86/4 `receipt_combined` with **both** ต้นฉบับ + สำเนา; the new buyer/seller Head Office/Branch
  field renders only for registrant buyers; capitalize-first `amount-to-english` unit test.

---

## 14. Rollout / sequencing

1. Migrations: `documentTypeEnum += 'bill'` (+ `'receipt_105'` if split); `bill_document_number_raw`
   + index; CHECK rewrites; `tenant_invoice_settings` WHT + seller-branch; `members` buyer-branch.
   Apply to `dev` Neon → `pnpm test:integration` before commit.
2. Domain/snapshots: branch fields + zod (additive); shared receipt-kind helper in `document-kind`.
3. Numbering: `issue-invoice` → `bill` stream; `record-payment` + `issue-event-invoice-as-paid` +
   `render-receipt-pdf` → `RC` at payment + payment-date receipt + Original/Copy.
4. Credit notes → receipt target + J2 re-target + receipt-rendered guard.
5. Template + presentation + i18n (all kinds).
6. Settings form + WHT note + branch UI.
7. Config cutover (SweCham → separate/RC + WHT text + seller branch) **before** first real document.
8. Tests regenerated; full gate (`lint && typecheck && test:coverage && check:i18n && check:* &&
   test:integration && test:e2e`). Accountant/RD sign-off on §12.

Because the §87 obligation moves between use-cases, **steps 1+3 must land together** — if
`issue-invoice` keeps allocating a §87 `invoice` number while `record-payment` starts allocating a
§87 `receipt` number, every sale mints **two** tax numbers (the exact duplicate-§86/4 the redesign
kills).

---

## 15. Notes

- This is a **Spec Kit-sized feature**, not a tweak (~30 files, ≥3 migrations, §87 re-architecture,
  tax-law surface). Recommend running it through the full pipeline
  (`/speckit.specify` → … → `/speckit.ship`) with a security/tax reviewer at the Review gate.
- prod is **test-data only** (wiped 2026-06-24) → no byte-stable re-render / backward-compat
  constraint; template-version gates can be simplified and a clean numbering cutover is acceptable.

---

## 16. Tax-auditor verification (2026-06-30) — corrections & broader traps

The `thai-tax-compliance-auditor` adversarially reviewed §1–§12. Verdict: **structure CORRECT**
(fixes duplicate-§86/4, §78/1 service tax-point = payment). Items 2, 3, 4, 7 **CONFIRMED**. Three
recommendations were corrected (folded inline above):

- **Branch render gate (§9):** gate on **VAT-registrant juristic person**, NOT `buyerHasTin` — a
  natural-person member's national ID is a TIN but they have no head office/branch.
- **WHT note (§10, BLOCKING):** wrong legal basis (entity-status vs payment-type) + over-broad scope
  → reword to หอการค้า-status basis and scope to **membership documents only**; confirm TSCC's RD
  status with the accountant.
- **RC/RE split (D2):** separate register is an **option, not required** (§87 gap-free is per-series).

**Broader traps to carry into implementation:**
- **(G) Payment-date fiscal year:** the §87 RC allocation at payment must derive its fiscal year from
  the **payment date in Asia/Bangkok** (a Dec-payment recorded in Jan numbers into the Dec FY) — not
  `now()` and not the bill's issue date.
- **(I) VAT math — biggest reuse trap:** the membership `receipt_combined` must keep **VAT-EXCLUSIVE**
  math at payment; only event Model B uses `splitVatInclusive`. Do not let the payment-path receipt
  accidentally inherit event VAT-inclusive logic.
- **(J) D4 confirmed:** Original+Copy satisfies §105ทวิ สำเนาคู่ฉบับ + §87/3 five-year retention.
- **(K) e-Tax:** if TSCC e-files RD e-Tax Invoice, branch must map to the `00000`/`00001` XML code and
  the buyer TIN must not be blank on a §86/4 — keep in mind for a later e-Tax phase.
- **(3) Edge cases for §86/4-at-payment:** NO §86/4 may be issued before payment (else §78/1(1)(ก)
  pulls the tax point back to issue); advance / partial / installment payments each form their own
  tax point (§82/10).

Full reviewer notes: `.claude/agent-memory/thai-tax-compliance-auditor/project_f4_tax_flow_redesign_review.md`.
