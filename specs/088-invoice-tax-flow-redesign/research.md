# F4 Tax-Flow Redesign — Research: Implementation Choices & Rationale

**Feature**: 088 — Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้)
**Branch**: `088-invoice-tax-flow-redesign`
**Date**: 2026-07-01
**Phase**: 0 (research / decisions)

## Overview

This document resolves every implementation question raised (or implied) in `spec.md` + `plan.md` and captures the evaluated alternatives for each. It distils the 8-surface technical map (`docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md`, file:line refs AS-IS at that commit), the accountant/RD tax research (`docs/superpowers/specs/2026-06-30-f4-accountant-questions.md`), and the `thai-tax-compliance-auditor` adversarial review. Tasks + code reference research items by number.

**Legal core (confirmed, not re-litigated below)**: membership dues are a **VATable service at 7%** (RD ruling **กค 0811/พ./2308** — a หอการค้า case, rd.go.th/25136.html); the VAT tax point for a service is **receipt of payment** (§78/1); there is **no withholding** on membership dues, basis **ม.65 ทวิ (13) + ท.ป.4/2528** (ruling **กค 0811/8542**, rd.go.th/25308.html) — the basis is the *dues exclusion*, **NOT** "the entity is income-tax-exempt". These resolved the two open tax questions; see §11.

**No open `NEEDS CLARIFICATION` remain.** All ambiguities were resolved via the 2026-07-01 clarify session (spec.md § Clarifications) + primary-source RD research + the tax-auditor pass. The only pre-ship residuals are three **fact confirmations** an accountant must sign (not design unknowns — see §11), and a handful of best-practice defaults the accountant may revise without blocking development (RC/RE split, bill cadence).

---

## 1. Relabel `PdfDocKind 'invoice'` in place vs. a new kind

**Decision**: **Relabel the existing `'invoice'` PdfDocKind in place** to ใบแจ้งหนี้ / Invoice. No new `PdfDocKind`, no `pdf_doc_kind` enum migration. (Design D5.)

- In `invoice-template.tsx`, change the `'invoice'` (and `'invoice_preview'`) title default from `titleTh='ใบกำกับภาษี' / titleEn='Tax Invoice'` (L196–221) to `titleTh='ใบแจ้งหนี้' / titleEn='Invoice'`.
- Make the ต้นฉบับ/ORIGINAL marker kind-aware (L225): `'invoice'`/`'invoice_preview'` → `null` (a ใบแจ้งหนี้ carries no Original marker); `receipt_separate` + `credit_note` keep their single Original.
- `receipt_combined`, `receipt_separate`, `credit_note` branches are otherwise structurally unchanged.

**Rationale**:
- The document's **legal identity now rests on the title alone** (§-citation footnote retired — see §7). The bill *is* still the same rendering pipeline, same props shape, same blob/sha contract; only its printed title + Original marker change. A rename is exactly that.
- Constitution X (Simplicity / YAGNI): a *new* `PdfDocKind 'bill'` would force **every** switch/gate/redaction-arm across the template, the annotatable-kind helper (`isCreditAnnotatable`, L194–195), the download surfaces, and the audit taxonomy to disambiguate tax-vs-non-tax — a wide, error-prone ripple for zero behavioural gain. The numbering-stream discriminator (§2) already carries the tax-vs-non-tax distinction where it actually matters (the §87 register).
- prod is **test-data only** (wiped 2026-06-24) → no historical `'invoice'` PDF must keep its old "Tax Invoice" title; a clean relabel is safe with no byte-stable / backward-compat constraint.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| New `PdfDocKind 'bill'` + `pdf_doc_kind` enum migration | Wide ripple across template switches, credit-annotatable gate, download surfaces, redaction arms, audit taxonomy — all to express a distinction already carried by the numbering stream. Violates Simplicity. |
| Keep title "Tax Invoice", only move numbering | Leaves the core illegality (a §86/4 title issued before the tax point) in place — the whole point of the feature. |

---

## 2. Non-§87 `bill` numbering stream + new `bill_document_number_raw` column — why NOT reuse `sequence_number`

**Decision**: Add a **new `bill` value to `documentType`** (`document_type` pgEnum, `schema-tenant-document-sequences.ts:13`, today `['invoice','receipt','credit_note']`) and store the bill's number in a **new nullable `invoices.bill_document_number_raw` column** guarded by a **partial unique index `(tenant_id, bill_document_number_raw) WHERE bill_document_number_raw IS NOT NULL`** (mirrors the existing `invoices_tenant_receipt_raw_uniq`). Bill prefix = `SC`, allocated at **issue**, non-§87 (gaps allowed). (Design D1, §6.)

**Rationale**:
- **`sequence_number` feeds the §87 uniqueness index `invoices_tenant_fiscal_seq_unique`, which has *no stream discriminator*.** A non-§87 bill number written into `sequence_number` would be **indistinguishable from a tax number** and could false-collide with (or falsely satisfy the no-gaps invariant of) the §86/4 tax register. The bill therefore needs a *physically separate* column so it can never enter the tax-uniqueness constraint (SC-003).
- A **new `documentType='bill'`** stream lets the existing gap-free allocator (`postgres-sequence-allocator.ts:37–129`, advisory lock `invoicing:{tenant}:{doc_type}:{fy}`) mint bill numbers on its own per-`(tenant, bill, fy)` counter — reusing all the year-boundary + advisory-lock machinery — while the allocator's §87 no-gaps *discipline* simply isn't asserted on this stream (a bill may gap freely per §87, which does not govern non-tax documents).
- The enum add follows the repo's **4-place convention** (domain const + Drizzle pgEnum + audit-event count test + completeness test — see MEMORY `add_audit_event_type_4_places` analog); typecheck alone misses the count assertions.

**DB CHECK constraints to amend** (`schema-invoices.ts`):
- `invoices_draft_has_no_number` (L279–286): accept a non-draft membership row whose number lives in `bill_document_number_raw` (with `sequence_number` NULL).
- `invoices_non_draft_has_snapshots` (L247–273): add a leg for `bill_document_number_raw NOT NULL AND sequence_number NULL AND document_number NULL`; **widen** the receipt-number leg (today gated `invoice_subject='event'`) so **membership** `receipt_combined` rows — which now carry `receipt_document_number_raw` with NULL sequence — also pass.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Reuse `invoices.sequence_number` / `document_number` for the bill | `sequence_number` feeds the discriminator-less §87 unique index → a non-tax bill number is indistinguishable from a tax number; false-collision / false-no-gaps risk. Recorded in plan.md § Complexity Tracking. |
| One shared numbering stream for bill + tax receipt | Same problem — the bill (non-§87) and the receipt (§87) must be provably disjoint (SC-002/SC-003). |
| No bill number at all (drafts stay unnumbered until paid) | The customer wants a payable ใบแจ้งหนี้ the member can reference before payment; a numbered bill is a business requirement (FR-001). |

---

## 3. Move §87 tax-number allocation from issue-time → payment-time (the biggest ripple)

**Decision**: **Move the §87 tax-number allocation out of issue and into the payment path.** `issue-invoice.ts` allocates only the non-§87 `bill` number (`SC`); the §87 `receipt` number (`RC`) is **allocated in-tx at the record-payment moment** inside `record-payment.ts` **and** `issue-event-invoice-as-paid.ts` — those two must behave identically. The async `render-receipt-pdf.ts` worker does **NOT** allocate: it only **reads** the already-allocated `receipt_document_number_raw` + `paymentDate` (for dating) and renders. (Design §4, §6, §7; spec FR-002/FR-005.)

**Rationale**:
- The §86/4 tax point for a service is **payment** (§78/1). Minting the §87 number at issue is the **root cause of the duplicate-§86/4** this feature removes; the number must be born at the tax point.
- **`record-payment.ts` (sync path)**: stop reusing `loaded.documentNumber`; always `allocateNext({documentType:'receipt', prefix:'RC'})` writing `receipt_document_number_raw`. **Delete the `combinedMode` reuse branch entirely** (L493–494, 590, 644–658) — `receiptNumberingMode` is now **always `'separate'`**: drop `'combined'` from the settings accepted values / CHECK / form **NOW** (fail-closed), so the settings flip's only remaining job is choosing the `RC` prefix. `record-payment` **allocates the §87 RC number in-tx** and enqueues the render — there is no reuse path left. Render dated at the **payment date** (D7), not `loaded.issueDate` (today L591 renders with the bill's date).
- **`issue-event-invoice-as-paid.ts` (L435–454)**: the TIN arm switches from `{documentType:'invoice'}` to `{documentType:'receipt', prefix:'RC'}`; the no-TIN arm → §105 `RE` stream (unchanged kind, D2).
- **`render-receipt-pdf.ts` (async/online worker, L181)**: today keys `combinedMode` on `receiptNumberingMode==='combined'` **only** — that branch is **gone** (combined mode retired). The worker must **read** the RC number from `receipt_document_number_raw` (**never allocate** — the number is already minted in `record-payment`'s tx) and **recompute the receipt kind** from `loaded.invoiceSubject` + buyer registrant-status via a shared Domain helper (`document-kind.ts` / `inferReceiptKind`, D13), else every membership receipt on the live async path renders as §105-only and loses its §86/4 identity. It dates the render at `paymentDate`. `FEATURE_F5_ASYNC_RECEIPT_PDF` decides which path is live; **both must be fixed identically** (spec Edge Case; FR-005).
- **Sync/async parity is the load-bearing invariant**: the online (Stripe) chain `confirm-payment → invoicing-bridge → markPaidFromProcessor → recordPayment` carries **no** receipt/numbering logic of its own (verified) — it is pure passthrough, so it inherits the new behaviour for free. PCI/SAQ-A scope is unchanged (Constitution IV): `recordPayment` now mints a tax number but touches no cardholder data.
- **Fiscal-year at payment (tax-auditor trap G)**: the §87 RC allocation must derive its fiscal year from the **payment date in Asia/Bangkok** (a Dec payment recorded in Jan numbers into the Dec FY) — not `now()` and not the bill's issue date. Reuses the F4 `js-joda` `ZonedDateTime` boundary logic already in the allocator.
- **VAT math (tax-auditor trap I)**: the membership `receipt_combined` must keep **VAT-EXCLUSIVE** math at payment; only event Model B uses `splitVatInclusive`. The payment-path receipt must not accidentally inherit event VAT-inclusive logic.
- **Overflow discipline moves with the allocation**: the "overflow-must-throw / no §87 gap" rule travels into `record-payment` + `issue-event-invoice-as-paid` (both already throw-in-tx → rollback releases the number → no gap). Reliability (Constitution VIII) preserved.
- **Sequencing constraint**: migration + numbering steps must land **together** — if `issue-invoice` keeps allocating a §87 `invoice` number while `record-payment` starts allocating a §87 `receipt` number, every sale mints **two** tax numbers (the exact duplicate this feature kills). See rollout §14 of the design.

**Hot-path note**: every membership payment now takes the `invoicing:{tenant}:receipt:{fy}` advisory lock (combined-mode previously took no receipt lock). Payments are low-frequency → acceptable (plan.md Performance Goals).

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Keep §87 at issue, only relabel the title | Leaves the duplicate-§86/4 and issues a tax number before the tax point — illegal (§78/1). |
| Allocate §87 only in `record-payment`, skip the async worker | The live async render path (`FEATURE_F5_ASYNC_RECEIPT_PDF`) would render membership receipts as §105-only, dropping the §86/4 identity. Both paths must be fixed. |
| Derive fiscal year from `now()` at commit | A cross-year payment (Dec paid, Jan recorded) would mis-file into the wrong §87 register — trap G. Must use payment-date/BKK. |

---

## 4. Original + Copy as two pages in one PDF

**Decision**: Render the `receipt_combined` as **two `<Page>` in one `<Document>`** — page 1 `ต้นฉบับ/ORIGINAL`, page 2 `สำเนา/COPY` — producing **one blob, one sha256, port unchanged**. (Design D4, §5.3; spec US2, FR-004.)

- Refactor the single `<Page>` body (`invoice-template.tsx` L242–464) into a reusable page-render fn taking a `copyMarker` param; emit two pages. The void stamp already uses `fixed` so it repeats across pages.

**Rationale**:
- **§105ทวิ สำเนาคู่ฉบับ** requires the seller to retain a copy; the customer also wants both in hand. Two pages in a single artifact satisfies §105ทวิ + §87/3 five-year retention (tax-auditor J: **confirmed**) with the least infrastructure change.
- **One blob / one sha keeps the storage + port contract identical** — no schema change to the PDF-artifact model, no double-write, no second blob key to reconcile on regeneration (matters for the credit-note re-render, §5). The `render→persist(sha)` invariant is untouched.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Two separate PDFs (Original blob + Copy blob) | Doubles the blob/sha bookkeeping, splits the atomic render, complicates credit-note J2 re-render (which blob carries the CREDITED stamp?). No legal benefit over a 2-page single file. |
| Single Original page only | Fails §105ทวิ คู่ฉบับ + the customer requirement (FR-004). |

---

## 5. Credit-note re-target to the receipt + creditable-only-after-payment

**Decision**: A §86/10 ใบลดหนี้ **references and annotates the §86/4 `receipt_combined`** (not the non-tax bill), and is **issuable only after the tax receipt has materialised**. (Design D6, §8; spec US6, FR-007.)

- `issue-credit-note.ts` (L472–473, 507–511): `originalDocumentNumber → loaded.receiptDocumentNumberRaw ?? loaded.documentNumber.raw`; `originalIssueDate → the receipt's date` (D7 = payment date).
- **Re-target the credited annotation (J2)** to the receipt blob (`loaded.receiptPdf.blobKey`, `kind:'receipt_combined'`) — **not** `loaded.pdf.blobKey` (now the non-tax ใบแจ้งหนี้). Persist via a **new `applyReceiptPdfRegeneration`** (updates `receipt_pdf_sha256`), not `applyInvoicePdfRegeneration`. The J2 re-render must reproduce the **Original+Copy** layout.
- **Creditability precondition becomes "has a rendered §86/4 receipt"**: the existing `paid`/`partially_credited` gate already implies this, but add an explicit guard on `receiptPdfStatus === 'rendered'` so a CN can never reference a receipt that is async-pending / failed. Crediting an **unpaid ใบแจ้งหนี้** is now (correctly) rejected — it is a non-tax document with no input VAT to reverse.
- Keep the `receipt_not_creditable` gate (event-no-TIN §105 stays non-creditable). Keep the CN's own `credit_note`/`CN` §86/10 stream (does **not** move to payment). The `cnRefBlock` label `อ้างอิงใบกำกับภาษีต้นฉบับ` stays valid (still points at the §86/4); only its *value* changes to the RC number.
- **Reconsider dropping `'invoice'` from `isCreditAnnotatable`** (L194–195) so the non-tax ใบแจ้งหนี้ never carries a §86/4-style CREDITED tax stamp.
- `drizzle-credit-note-repo.ts:388` `listPaged` projection → surface the RC receipt number.

**Rationale**:
- A credit note reverses **output VAT that was actually charged**. VAT is charged only at payment (on the §86/4 receipt). Crediting a non-tax bill would purport to reverse VAT that was never charged — legally meaningless. So the CN must target the receipt and cannot precede it.
- Tax-auditor item 4: **confirmed** that a §86/10 is issuable only after the §86/4 exists — a deliberate behaviour change from "credit an issued invoice", called out in spec US6 AS1.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Keep the CN targeting the bill (`document_number`) | The bill is now non-tax; a §86/10 against it references a non-existent §86/4 → legally void. |
| Allow crediting an unpaid bill | No output VAT to reverse; the correct pre-payment adjustment is edit/cancel the **bill**, not a credit note (tax research E1). |
| Annotate `loaded.pdf.blobKey` (the bill) with the CREDITED stamp | Would stamp a §86/4-style CREDITED mark on a non-tax document; re-target to the receipt blob. |

---

## 6. §86/4 Head-Office / Branch data model (admin-only, gate on VAT-registrant juristic buyer)

**Decision**: Add a **Head Office / Branch** indicator to **both** registrant parties, stored on the member record + tenant settings, **admin-only**, rendered **only for a VAT-registrant juristic buyer** — **NOT** merely `buyerHasTin(...)`. (Design §9; spec US3, FR-008; tax-auditor correction.)

- **Seller** (`tenant_invoice_settings` → `TenantIdentitySnapshot`): `seller_is_head_office boolean NOT NULL DEFAULT true` + `seller_branch_code char(5)` nullable. Seller always renders `สำนักงานใหญ่` or `สาขาที่ {code}`.
- **Buyer (F3 member)** (`members` → `MemberIdentitySnapshot`): `is_head_office boolean NOT NULL DEFAULT true` + `branch_code char(5)`. Read in `member-identity-adapter.ts:getForIssue` SELECT (L47–84), written onto the snapshot (L152–174). **Admin-only** edit — tax-critical like `tax_id`, **not** member-self-editable.
- **Buyer (non-member event)**: extend the manual buyer object in `create-event-invoice-draft.ts` (L99–110, 278–284).
- **Snapshot zod (additive)**: add `buyer_is_head_office` + `buyer_branch_code` with the `.optional().default(...)` posture already used by `member_number`, plus a `.superRefine` pairing rule (head-office ⇒ code null; branch ⇒ `/^\d{5}$/`). Historical JSONB snapshots default to "head office / null".
- **Render on both documents** (clarify 2026-07-01): the branch line appears on **both** the ใบแจ้งหนี้ and the tax receipt, from the same immutable issue-time snapshot (harmless on the bill; keeps the two documents consistent).

**Rationale (the tax-auditor correction — do not regress)**:
- ⚠️ A natural-person member's 13-digit **national ID is usable AS a TIN**, but that person is **NOT a VAT registrant** and has **no head office/branch**. Gating the branch line on `buyerHasTin(...)` would render a nonsensical `สำนักงานใหญ่` for an individual.
- The correct gate is a **`buyerIsVatRegistrant` / juristic discriminator** (e.g. derived from `legalEntityType ≠ individual`) — the **same axis on which the buyer TIN itself is §86/4-mandatory**. An individual (non-registrant) shows **no** branch line (spec US3 AS3).
- **Default = สำนักงานใหญ่, never blocks issuance** (tax research F1): the 131-member import defaults to head office; admin corrects only genuine branches; a §86/4 receipt can always issue even if the branch is unknown (spec US3 AS1, Edge Case). Wrong branch is correctable later (auditor: low-risk).
- New PII (`members.branch_code`) lawful basis = Thai RD tax-invoice legal obligation (PDPA §24 / GDPR Art. 6(1)(c)); admin-only RBAC; two-layer tenant isolation preserved (RLS + FORCE + `runInTenant`).
- **e-Tax forward-compat (tax-auditor K)**: keep the branch mapping to the `00000`/`00001` XML code in mind for a later e-Tax phase (out of scope now; hook designed-in).

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Gate the branch line on `buyerHasTin(...)` | Renders a nonsensical head-office line for a natural-person member whose national ID doubles as a TIN. Tax-auditor catch. |
| Per-invoice buyer-branch override UI | Out of scope for v1 — member-record value is authoritative (spec Out of Scope); avoids a snapshot-vs-override reconciliation surface. |
| Require explicit branch before issuing a §86/4 | Would block issuance on missing data for 131 members; default-to-head-office is the pragmatic, auditor-endorsed posture. |

---

## 7. Tenant-configurable WHT footer (settings → snapshot → template) + drop the §-citation

**Decision**: **Retire the hardcoded "Rendered by Chamber-OS (§-citation)" footer** and replace it with a **tenant-configurable withholding-tax note** that rides `settings → TenantIdentitySnapshot (pinned at issue) → template`, renders on **`invoice_subject='membership'` documents only**, and is **editable** via tenant settings (never a template literal). A tenant with no note configured renders nothing. (Design D3, §5.4, §10; spec US5, FR-012; tax-auditor BLOCKING catch.)

- **Template** (`invoice-template.tsx` L461–463): replace `Rendered by Chamber-OS ({citation})` with the WHT note from the snapshot. **Retire** the §-citation machinery (`revenue-code-citation.ts`, `KIND_AWARE_CITATION_MIN_VERSION`, the `footerCitation` branch L233–236). Legal §-identity now rests on the **title alone** (tax research G2: §-citation is not a §86/4-mandated particular — **confirmed**, accountant sign-off item 2).
- **Settings**: `tenant_invoice_settings.wht_note_th text NULL` + `wht_note_en text NULL` (NULL ⇒ render nothing → non-SweCham tenants get no stray text). Threaded through schema → `drizzle-tenant-settings-repo` (rowToView L60–67 + upsert copyFields L220–238) → port patch → `update-tenant-invoice-settings` zod + patch → API `route.ts` (body/GET/PATCH) → settings page → `invoice-settings-form.tsx` (textareas) → i18n. Immutable at issue per FR-011 (pinned into the snapshot).
- **Render gate = per-document `invoice_subject`** (tax-auditor BLOCKING scope correction): render **only** on `membership`, **never** on event / sponsorship / advertising documents.

**Rationale (the tax-auditor corrections — do not regress)**:
- The **wording** must not conflate **entity income-tax status** with **payment-type WHT obligation**. WHT (§3เตรส/§50, ท.ป.4/2528) triggers on the *type of income paid*, not solely on recipient status. The correct **legal basis is the dues exclusion under ม.65 ทวิ (13) + ท.ป.4/2528** (ruling กค 0811/8542) — "ค่าบำรุงสมาชิก … เป็นรายได้ที่ได้รับยกเว้น ผู้จ่ายจึงไม่มีหน้าที่หักภาษี ณ ที่จ่าย" — **NOT** a blanket "entity exempt". **The seeded default is แบบ A** (the customer-chosen wording) — TH *"หอการค้าไทย-สวีเดนได้รับการยกเว้นภาษีเงินได้ไม่ต้องหักภาษี ณ ที่จ่าย"* / EN *"No deduction of withholding tax shall apply, as the income is exempt from income tax."* — whose "entity income-tax-exempt" framing is **legally imprecise** (it asserts entity status rather than the dues-exclusion basis). The precise alternative is **แบบ B**: *"ค่าบำรุงสมาชิกเป็นรายได้ที่ได้รับยกเว้นตามมาตรา 65 ทวิ (13) แห่งประมวลรัษฎากร ผู้จ่ายจึงไม่มีหน้าที่หักภาษี ณ ที่จ่าย"*. Because the note is an editable settings field, **the accountant signs off แบบ A vs แบบ B at the Review gate before first issuance** — no code deploy is needed to swap the wording, and **ม.65 ทวิ (13) remains the cited basis either way**. (Fix the source typos `ภาษาเงินได้/หักภาษา` → `ภาษีเงินได้/หักภาษี` in whichever wording is adopted.)
- **Scope to membership only**: event-fee / sponsorship / advertising receipts may be **taxable commercial income the payer DOES withhold on** (e.g. advertising 2%). Printing the exemption note there **mis-advises** the payer. Hence the render gate keys on the per-document subject, not a per-tenant blanket (spec US5 AS2, SC-007).
- **Editable, not locked**: because the wording is a legal statement the accountant may refine, it lives as a settings text field — no code deploy to correct it.
- **VAT-vs-WHT tension resolved**: "if dues are a VATable ค่าบริการ (7%), why no 3% WHT under ท.ป.4 ข้อ 12/8?" — resolved by the **chamber-status dues exclusion** (ม.65 ทวิ (13)); the note states the exclusion basis, and the two are independent (VAT ≠ income-tax/WHT).

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Hardcode the TSCC WHT text in the template | Multi-tenant leak (other tenants get TSCC's note) + not editable when the accountant refines wording. Must be a settings field. |
| Keep the §-citation footnote | Not a §86/4-mandated particular (G2 confirmed); the WHT note replaces it and the title carries legal identity. |
| Render the note on all document subjects | Mis-advises payers on taxable event/advertising income (auditor BLOCKING) — gate per-subject to membership. |
| Treat แบบ A's "entity income-tax-exempt" framing as the settled legal basis (lock it, no review) | แบบ A is the customer-chosen **seed**, not the settled basis; its framing is legally imprecise (asserts entity status, not the ม.65 ทวิ (13) dues-exclusion basis). Keep แบบ A as the seed but make it an accountant sign-off item (แบบ A vs the precise แบบ B) at Review before first issuance — do not silently lock it in. |

---

## 8. Presentation polish (deterministic, all kinds)

**Decision**: Apply the customer's formatting revisions via the **single shared template** so all kinds inherit them, using **deterministic, locale-independent** implementations. (Design §5.5; spec US4, FR-009/FR-010/FR-011.)

- **Thousands-separator commas** in `formatThbSatang` (L169–173) — implement grouping **manually**, do **not** use `toLocaleString` (locale-dependent → non-deterministic). Ripples to L396/397/405/411/418/454.
- **Capitalize** the first letter of the English amount-in-words — centralize in `amount-to-english.ts` (handle `'zero'`) so every kind inherits it.
- **Reorder the buyer block** (L320–361): **Name → Address → Tax ID → Head Office/Branch** → then Member No., Contact (FR-010).
- **Add the §86/4 `สำนักงานใหญ่ / Head Office | สาขาที่ NNNNN / Branch` line** to the **seller** (L287–293) and buyer blocks (§6).
- **Membership line description** carries plan name + coverage period, e.g. `Swecham Premium Corporate Membership fee 2026 / Period: Jan–Dec 2026` (`create-invoice-draft.ts:228–235` — needs the plan display name + period dates) (FR-011).
- **Template version** → bump `CURRENT_TEMPLATE_VERSION` to 4; **delete the v1/v2 byte-stable-preservation gate** (prod is test-data only → no SC-003 byte-identical constraint).

**Rationale**:
- Determinism is a standing F4 invariant (PDFs are content-addressed by sha256; goldens are text-extraction assertions). `toLocaleString`'s grouping/format depends on the runtime ICU locale → forbidden on this path; a manual grouping function is stable across environments.
- Centralizing capitalization + comma grouping in the shared helpers means the polish applies uniformly to bill, receipt, §105, and credit note with no per-kind duplication (Constitution: Reusable / DRY).

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| `Number.prototype.toLocaleString('en-US')` for grouping | Locale/ICU-dependent → non-deterministic PDF bytes; breaks the sha256 content-addressing invariant. |
| Per-kind formatting tweaks | Duplication across four kinds; drift risk. Centralize in the shared template + helpers. |

---

## 9. §105 RE / RC register (separate default, revisable)

**Decision**: Give the event-no-TIN §105 plain receipt its **own numbering stream/prefix `RE`**, separate from the §86/4 combined-receipt `RC` register — as the **conservative default** — while recording that this is **OPTIONAL, not required by §87** and may be merged on the accountant's preference. (Design D2, §6; spec Assumptions; tax-auditor item 1.)

- Implement as `documentType='receipt_105'` (new enum value) **or** a shared `receipt` stream with an `RE` prefix; both allocate a gap-free number at payment (as-paid), stored in `receipt_document_number_raw`.

**Rationale**:
- **§87 gap-free is per-series, not a duty to maintain a §86/4-only register** (tax-auditor item 1, an explicit correction). RC (combined §86/4) and RE (§105 plain, no-TIN event) **both** carry 7% output VAT and both feed รายงานภาษีขาย / ภ.พ.30, so **one mixed-but-gap-free `receipt` register also satisfies §87** (matches the existing shared-register β-numbering ruling).
- Separate RC/RE is chosen as the **tidier, audit-friendly OPTION** (clean §86/4-only register for inspection) — but because the simpler shared register is **equally legal**, this is an operational-preference call the accountant may revise **without blocking development**.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| One shared `RC` register for all receipts | Equally legal (§87 per-series), simpler — kept as the revisable fallback, but separate RE is tidier for audit and chosen as default. |
| Merge §105 into the §86/4 kind | The event-no-TIN receipt keeps its distinct §105 legal identity (no §86/4 particulars, non-creditable) — only inherits the cosmetic polish. |

---

## 10. New / changed audit events

**Decision**: Preserve full audit coverage across the moved tax-number lifecycle. Emit a **bill-issued** event at issue and a **new `tax_receipt_issued`** event (§86/4 tax number allocated) fired **at the record-payment RC-allocation moment** — the same in-tx moment the RC is minted, on **both** the sync and async paths, **distinct from `invoice_issued`** — keep the existing credit-note events, and add a **tenant-settings-updated** discriminator for the new WHT-note / seller-branch fields. `tax_receipt_issued` is a **NEW enum value** carrying **10-year** retention and is the **SC-001 signal** ("one §86/4 per sale, minted at the tax point"). Every new audit type is registered in the repo's **4 canonical places** (domain const + Drizzle pgEnum + audit-event count test + completeness count test). (Design §7/§8/§10; plan Constitution IV/VIII.)

**Rationale**:
- The §87 obligation now lives on the **payment** use-cases; the audit trail must show *where the tax number was born* (**`tax_receipt_issued`**, fired at the record-payment RC allocation, dated at the tax point) distinctly from *where the bill was numbered* (issue, `bill_issued`). `tax_receipt_issued` is the compliance evidence for "one §86/4 per sale, minted at the tax point" (SC-001) and the numbering cutover.
- Tenant-settings changes to the **WHT note** and **seller branch** are tax-material and admin-only → they must be auditable like other `tenant_invoice_settings` mutations.
- Retention: tax-material events (including **`tax_receipt_issued`**) inherit the F4 **10-year** retention posture (Thai RD §87/3 + GDPR Art. 6(1)(c)); non-tax bill events follow the default 5-year posture. (The 4-place registration + count tests gate the new enum value; the pay contract + `data-model.md` audit-taxonomy table list it.)

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Reuse the existing "invoice issued" event for both bill and receipt | Collapses two legally distinct moments (non-tax numbering vs §87 tax-point allocation); the audit trail could not evidence SC-001. |
| Add enum values in TS only | typecheck misses the count-assertion tests; the repo convention requires all 4 places (MEMORY `add_audit_event_type_4_places`). |

---

## 11. Confirmed tax basis, accountant fact-confirms, and tax-auditor corrections

**Decision**: Proceed on the **RD-researched legal basis** below, treating the three remaining items as **accountant *fact* confirmations** (not design unknowns) and the tax-auditor corrections as **binding on implementation**. (Design §10/§12/§16; accountant-questions §A/§B; spec Assumptions + Dependencies.)

**Confirmed law (primary rd.go.th sources, do not re-litigate)**:
- Membership dues = **VATable service 7%** — ruling **กค 0811/พ./2308** (a หอการค้า case), rd.go.th/25136.html.
- **No withholding** on membership dues — basis **ม.65 ทวิ (13) + ท.ป.4/2528**, ruling **กค 0811/8542**, rd.go.th/25308.html. Basis is the **dues exclusion**, **NOT** "entity income-tax-exempt". ⚠️ ม.65 ทวิ (13) exempts **income tax only, NOT VAT** — a common trap.
- Service VAT tax point = **payment** (§78/1); §86/4 must **not** be issued before payment (else §78/1(1)(ก) pulls the tax point back to issue); advance / partial / installment payments each form their own tax point (§82/10) — deferred beyond MVP (single full payment).

**Three accountant FACT-confirms before ship (Review-gate blocker, not a design gap)**:
1. **TSCC is VAT-registered** (revenue > 1.8M THB/yr).
2. **No fee tier is volume-based** — if any tier is priced on business volume, that income is ม.40(8) → **withholding *does* apply**, which would change the WHT-note gate.
3. **The WHT-note wording — แบบ A vs แบบ B.** The seeded default is **แบบ A** (customer wording, the legally imprecise "entity income-tax-exempt" framing); the accountant signs off แบบ A vs the precise **แบบ B** (the ม.65 ทวิ (13) dues-exclusion wording) at Review before first issuance. *(The membership-only render scope — not event / sponsorship / advertising — is now a **resolved best-practice decision**, no longer a fact-confirm.)*

**Tax-auditor corrections (binding — folded into the sections above)**:
- **Branch render gate** = VAT-registrant juristic buyer, **NOT** `buyerHasTin` (§6).
- **WHT note** = correct dues-exclusion basis (**ม.65 ทวิ (13)**) + membership-only scope; editable settings field (§7). **Seed = แบบ A** (customer wording, legally imprecise); the accountant signs off แบบ A vs the precise **แบบ B** at Review before first issuance.
- **RC/RE split** = an option, not required by §87 (§9).
- **Trap G** (payment-date/BKK fiscal year), **Trap I** (keep membership VAT-exclusive at payment), **J** (Original+Copy satisfies §105ทวิ + §87/3 — confirmed), **K** (e-Tax branch-code hook, later phase).

**No open `NEEDS CLARIFICATION` remain.** The two open tax questions (VAT status, WHT basis) were resolved by primary-source RD rulings; all C–G items have accountant-revisable best-practice defaults that do **not** block development; the three fact-confirms are operational sign-offs at the Review gate, not design unknowns.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Wait for full accountant sign-off before any code | The *law* is resolved (primary rulings); only three facts + revisable defaults remain — blocking dev on them wastes the resolved-design window. Fact-confirms gate **ship**, not dev. |
| Treat แบบ A's "entity income-tax-exempt" framing as the settled legal basis for the WHT note | แบบ A is the customer-chosen **seed**, not the settled basis; its framing is legally imprecise (conflates entity status with payment-type WHT). Keep แบบ A as the seed but sign it off vs the precise **แบบ B** at Review; the RD-correct **basis** is the ม.65 ทวิ (13) dues exclusion either way. |
| Rely on `buyerHasTin` as the registrant proxy | A natural-person national ID is a TIN but not a VAT registration → wrong branch rendering. Use a juristic/registrant discriminator. |

---

## 12. §80/1(5) embassy zero-rate — modelling (D19)

**Decision**: Model the Embassy / international-organization VAT zero-rate as a **per-invoice `vat_treatment` enum** (`invoices.vat_treatment`, default `'standard'` = 7%, or `'zero_rated_80_1_5'` = 0%) — **NOT** a per-member flag — with **MFA-certificate capture** (`zero_rate_cert_no` / `zero_rate_cert_date` / optional `zero_rate_cert_blob_key`) that is **REQUIRED and fail-closed** whenever `vat_treatment='zero_rated_80_1_5'`, VAT **computed at 0%** (`vat_rate` 0, `vat_amount` 0) as a **VATable-at-0% supply** (creditable / reportable), and the treatment **pinned into the immutable issue-time snapshot**. **Zero-rate ≠ §81 exemption**: it is still a **full §86/4 tax invoice**, the supplier is a **§82/3 VAT registrant applying the 0% rate**, input VAT stays **claimable**, and the sale is reported as **zero-rate sales on ภพ.30**. Admin sets the treatment at issue; case-by-case per embassy notification. (Spec US8 (P3), FR-023 / FR-024 / FR-025; SC-008.)

- **Per-invoice enum (FR-023)**: `vat_treatment` defaults to `'standard'`; membership rows **always** stay `'standard'` (7%). Zero-rate applies **only** to non-membership embassy / int'l-org sales (event / service — e.g. Embassy of Sweden expo-booth construction). Pinned into the same immutable `TenantIdentitySnapshot` / issue-time snapshot posture as the other §86/4 particulars, so a later member/settings edit cannot mutate an issued document.
- **MFA-cert capture, fail-closed (FR-024)**: `zero_rate_cert_no` (the MFA note number, e.g. `กต 0404/…`) + `zero_rate_cert_date` + optional `zero_rate_cert_blob_key` (scan of the RD-approved certificate — **reuse the F4 invoice-PDF Vercel Blob adapter**, no new infra). A `zero_rated_80_1_5` invoice with a **NULL `zero_rate_cert_no` is BLOCKED** (fail-closed, evidence-required). A **≥ 5,000 baht** per-purchase floor is a **warn, not a hard-block**.
- **VAT computation (FR-025)**: `zero_rated_80_1_5` → `vat_rate` 0%, `vat_amount` 0, but the supply is **VATable at 0%** (creditable / reportable on ภพ.30), **NOT** §81-exempt; `standard` → VAT 7% exactly as today (VAT-exclusive membership math, §3/§8 unchanged).
- **Rendering (FR-025)**: the **ใบแจ้งหนี้ (bill)** shows VAT **0% / 0.00**, total = base; the **§86/4 tax invoice/receipt at payment** is a **FULL §86/4 tax invoice at VAT 0%** PLUS a **§80/1(5) note** ("VAT 0% under §80/1(5); MFA certificate no. …") with the certificate reference / attachment. **Original + Copy (§4/D4) unchanged.** The **WHT note** (membership-only, FR-012, §7) does **not** render on these non-membership documents.
- **Numbering unchanged**: bill `SC` stream + receipt `RC` §87 stream (§2, §3) are untouched — zero-rate does **not** change numbering.
- **Migration**: the new `invoices` columns (`vat_treatment` + the three `zero_rate_cert_*` fields) land in a **new additive migration `0234`** (after `0230–0233`); keep the "next free migration index" bookkeeping at `0234`.
- **Audit**: capture `vat_treatment` (+ `zero_rate_cert_no` when zero-rated) in the **`invoice_issued`** and **`tax_receipt_issued`** audit payloads (§10) — **no separate audit event** needed.

**Rationale**:
- **RD-approved certificates VAT 326-24 / 327-24 / 351-24** (Ministry of Foreign Affairs, Protocol Department) authorise the Thai-Swedish Chamber to zero-rate sales of goods/services to **embassies / international organizations** under **Revenue Code §80/1(5)**. This is a **zero-rated VATable supply** (§82/3 registrant applying 0%), **not** a §81 exemption — so a full §86/4 tax invoice still issues, VAT is computed at 0%, input VAT is claimable, and the sale is reported as zero-rate sales on ภพ.30.
- **Accountant-confirmed (2026-07-01)**: TSCC has **NO §81-exempt "No VAT" items** — every line is either **VAT 7% (standard)** or **VAT 0% (embassy §80/1(5))**. Zero-rate is **embassy / int'l-org ONLY, case-by-case**: the embassy applies to the MFA, which issues the certificate the embassy hands to TSCC to attach, and the embassy notifies TSCC per transaction. **Membership is ALWAYS VAT 7%.** This confirmation is what makes per-**invoice** (not per-member) treatment + mandatory certificate capture the correct model.
- Folding US8 into core 088 (previously flagged as a fast-follow) keeps the zero-rate path on the **same §86/4 tax-invoice-at-payment machinery** built for the core flow — the bill/receipt split, snapshot pinning, and RC §87 numbering all apply unchanged; only the VAT rate, the §80/1(5) note, and the certificate evidence differ.

**Alternatives considered**:

| Option | Rejected because |
|---|---|
| Per-**member** zero-rate flag (mark an embassy member as "always 0%") | Zero-rate is **case-by-case per embassy MFA notification per transaction**, not a stable member attribute — a member flag would wrongly zero-rate transactions that lack a certificate. It must live on the **invoice** and be pinned in the issue-time snapshot (FR-023). |
| Treat the sale as **§81-exempt / a plain (non-tax) receipt** | §80/1(5) is a **zero-rate (0%) VATable supply**, **not** a §81 exemption: a full **§86/4 tax invoice** still issues, input VAT stays **claimable**, and it is reported as **zero-rate sales on ภพ.30**. Rendering it as an exempt/plain receipt would drop the §86/4 identity and mis-state the ภพ.30 line. |

---

## References

- Design map: `docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md` (8-surface, file:line AS-IS).
- Accountant/RD research: `docs/superpowers/specs/2026-06-30-f4-accountant-questions.md`.
- Tax-auditor notes: `.claude/agent-memory/thai-tax-compliance-auditor/project_f4_tax_flow_redesign_review.md`.
- RD rulings: กค 0811/พ./2308 (rd.go.th/25136.html) · กค 0811/8542 (rd.go.th/25308.html).
- Prior art: `specs/007-invoices-receipts/research.md` (F4 numbering allocator, PDF engine, receipt representation).
- Repo conventions: MEMORY `add_audit_event_type_4_places`, `feedback_migration_apply_before_commit`, `project_drizzle_repo_tx_pattern`.

---

## Critique remediation (2026-07-01)

*Decisions added/corrected after the dual-lens critique (`critiques/critique-20260701-124839.md`).*

- **D12 (corrects §6) — buyer VAT-registrant discriminator.** The branch-render gate needs a snapshot field; there is none, so §6's "gate on VAT-registrant juristic" would silently fall back to `buyerHasTin` (auditor-forbidden). **Decision:** add `buyer_is_vat_registrant` to the identity snapshot (from `members.legal_entity_type`), fail-closed on NULL/unknown. **Alternatives:** reuse `buyerHasTin` (rejected — over-includes natural persons whose national ID is a TIN).
- **D13 — new `inferReceiptKind` resolver.** **Decision:** add a dedicated payment-time resolver (membership→`receipt_combined`; event+TIN→`receipt_combined`; event+noTIN→`receipt_separate`). **Alternatives:** reuse `inferEventDocumentKind` (rejected — it returns `'invoice'` for membership → would render the receipt with the non-tax ใบแจ้งหนี้ label, a §86/4 identity loss).
- **D14 — async worker null-safety + payment date/FY.** **Decision:** `render-receipt-pdf.ts` sources the number from `receipt_document_number_raw` (membership bills have `document_number = NULL`), takes `paymentDate` + payment-BKK `fiscalYear`, and null-safes every `documentNumber` deref. **Alternatives:** leave the doc-number guard (rejected — NPEs/rejects every membership receipt on the async path when `FEATURE_F5_ASYNC_RECEIPT_PDF` is on).
- **D15 — `void-invoice.ts` in scope.** **Decision:** bill-number fallback + default-title relabel so a voided unpaid bill renders ใบแจ้งหนี้. **Alternatives:** omit (rejected — void of an unpaid bill NPEs on the missing number and re-titles as Tax Invoice).
- **D16 — feature-flagged, verifiable, reversible cutover.** **Decision:** `FEATURE_088_TAX_AT_PAYMENT` flag + `scripts/verify-088-cutover.ts` + `issue-invoice` bill-stream-only runtime assertion + FR-017 in-flight guard; rollback = flag/code/settings revert (enum-add + consumed §87 numbers are irreversible). **Alternatives:** "steps must land together" prose only (rejected — a partial rollout mints two §87 numbers per sale; no rollback path violates Constitution Gate X).
- **D17 — renewal (F8) parity.** **Decision:** renewal-generated membership invoices are first-class in-scope (non-tax bill → RC receipt at renewal payment; renewal email/success copy). **Alternatives:** rely on implicit inheritance (rejected — unverified; renewal is the recurring-revenue path).
- **D18 — user-facing completeness.** **Decision:** two-document disambiguation UX (FR-016), email-template relabel (FR-020), and production SC signals (alert on `>1 §87 number per paid row`, `pdf_render_permanently_failed`). **Alternatives:** build-time SC checks only (rejected — SC-001/004 unprovable in prod).
