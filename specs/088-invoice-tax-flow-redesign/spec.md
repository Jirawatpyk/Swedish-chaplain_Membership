# Feature Specification: Invoice / Receipt Tax-Flow Redesign (bill → ใบแจ้งหนี้)

**Feature Branch**: `088-invoice-tax-flow-redesign`
**Created**: 2026-07-01
**Status**: Draft
**Input**: Customer revision requests on the F4 invoice/receipt documents (2026-06-30), consolidated design + tax research in `docs/superpowers/specs/2026-06-30-f4-invoice-receipt-tax-flow-redesign-design.md` and the accountant question sheet `docs/superpowers/specs/2026-06-30-f4-accountant-questions.md`.

## Overview

Today the platform issues a **§86/4 ใบกำกับภาษี / Tax Invoice at billing time** and a **second §86/4 document (ใบกำกับภาษี/ใบเสร็จรับเงิน) at payment**, so a member receives **two tax invoices for one sale**. For a service (membership / event fee) the Thai VAT tax point is at **receipt of payment** (Revenue Code §78/1). This feature corrects the flow: the pre-payment document becomes a **non-tax ใบแจ้งหนี้ / Invoice**, and the single §86/4 + §105ทวิ **ใบกำกับภาษี / ใบเสร็จรับเงิน** is issued only at payment. It also delivers the customer's document-presentation revisions and the §86/4 completeness items surfaced during review.

## Clarifications

### Session 2026-07-01

- Q: On which documents do the withholding-tax note and the Head Office/Branch §86/4 fields render — the non-tax bill, the tax receipt, or both? → A: **Both** — the ใบแจ้งหนี้ (bill) and the ใบกำกับภาษี/ใบเสร็จรับเงิน (tax receipt) render both fields, drawn from the same immutable issue-time snapshot (the WHT note is most actionable on the bill the member pays against; the branch line is harmless on the bill and keeps the two documents consistent).
- Q: After a membership bill is paid, which documents remain downloadable? → A: **Both** — the ใบแจ้งหนี้ (bill) and the tax receipt stay available to admin and member; the bill is NOT hidden once paid (they are two distinct legal documents: a payable record and a tax receipt).
- Q: When a PAID membership is voided, which of its two PDF blobs (bill vs tax receipt) is VOID-stamped? → A: **Both** — the ใบแจ้งหนี้ bill blob and the ใบกำกับภาษี/ใบเสร็จ tax-receipt blob are both VOID-stamped (both remain downloadable per FR-015, so neither may look valid after a void). Note: cancelling an issued §86/4 receipt is normally done via a §86/10 credit note; void is the edge path.
- Q: Audit evidence for SC-001 (the tax number is born at payment) — reuse `invoice_issued` or add a dedicated event? → A: **Add a dedicated `tax_receipt_issued` audit event** at payment-time §87 allocation (10-year retention, like other tax-document events), keeping `invoice_issued` for the bill; this is the queryable SC-001 signal. It is a 4-place enum add (domain const + pgEnum + audit-event count test + completeness test). (`tenant_receipt_prefix_changed` already exists — not new.)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Non-tax bill → tax receipt issued at payment (Priority: P1)

The pre-payment membership document must be a plain **ใบแจ้งหนี้ / Invoice** (not a tax invoice), and the single **ใบกำกับภาษี / ใบเสร็จรับเงิน** must be issued only when payment is received — so a member never receives two §86/4 tax invoices for one membership.

**Why this priority**: this is the legal-correctness core (§78/1 service tax point = payment). Every other item depends on it, and it removes the duplicate-§86/4 exposure.

**Independent Test**: issue a membership bill and confirm the PDF is a non-tax ใบแจ้งหนี้ carrying a non-§87 bill number; then complete payment and confirm one ใบกำกับภาษี/ใบเสร็จรับเงิน is produced, dated at the payment date, carrying the §87 tax number.

**Acceptance Scenarios**:

1. **Given** a draft membership invoice, **When** an admin issues it, **Then** the buyer receives a document titled "ใบแจ้งหนี้ / Invoice" with a bill number (e.g. `SC-2026-000123`), **no** §86/4 tax-invoice title, **no** "ต้นฉบับ / ORIGINAL" marker, and **no** Revenue-Code §-citation.
2. **Given** an issued (unpaid) membership ใบแจ้งหนี้, **When** the member pays online (card / PromptPay) **or** an admin records an offline payment, **Then** the system issues exactly one "ใบกำกับภาษี / ใบเสร็จรับเงิน" bearing the §87 tax number (e.g. `RC-2026-000045`), dated at the **payment date** (Asia/Bangkok).
3. **Given** any membership sale, **Then** no §87 tax number is consumed at billing — the bill number is a separate, non-§87 series that may have gaps without violating §87.
4. **Given** a member who has paid, **Then** they hold exactly **one** §86/4 tax document (the payment-time receipt), never two.
5. **Given** a renewal-generated membership invoice (F8), **When** it is issued and later paid (online or offline), **Then** it follows the same ใบแจ้งหนี้ → RC tax-receipt flow (no §87 at issue; RC at payment) and the renewal email / success screen reference the correct documents.

---

### User Story 2 - Tax receipt renders Original + Copy (Priority: P1)

The ใบกำกับภาษี/ใบเสร็จรับเงิน must present both a **ต้นฉบับ (Original)** and a **สำเนา (Copy)** — satisfying §105ทวิ คู่ฉบับ and §87/3 retention.

**Why this priority**: a §86/4 tax receipt is incomplete without the copy pair; it ships with US1.

**Independent Test**: generate a payment-time receipt and confirm the single PDF contains two pages — page 1 marked ต้นฉบับ/ORIGINAL, page 2 marked สำเนา/COPY — sharing one document number.

**Acceptance Scenarios**:

1. **Given** a completed payment, **When** the tax receipt is generated, **Then** the resulting single PDF has two pages: an Original (ต้นฉบับ) and a Copy (สำเนา), both showing the same RC tax number.

---

### User Story 3 - §86/4 Head Office / Branch on both parties (Priority: P2)

Seller and buyer §86/4 blocks must show a **สำนักงานใหญ่ / Head Office** or **สาขาที่ NNNNN / Branch** indicator. Buyer branch is captured on the member record (admin-managed), defaulting to สำนักงานใหญ่ when unknown, and rendered only for VAT-registrant juristic buyers.

**Why this priority**: a §86/4 required particular that is currently absent; needed for a compliant tax receipt but does not block the core flow.

**Independent Test**: set a member's branch on their record, issue and pay → confirm the receipt shows the buyer's Head Office/Branch line; a member with no branch data shows สำนักงานใหญ่; an individual (non-registrant) shows no branch line; the seller always shows TSCC head office.

**Acceptance Scenarios**:

1. **Given** a VAT-registrant corporate member with no branch set, **When** a receipt issues, **Then** the buyer block shows "สำนักงานใหญ่ / Head Office" (default) and issuance is not blocked.
2. **Given** a member set to a specific branch code, **When** a receipt issues, **Then** the buyer block shows "สาขาที่ NNNNN / Branch".
3. **Given** an individual (non-registrant) buyer, **Then** no Head Office/Branch line renders.
4. **Given** any tax document, **Then** the seller block shows TSCC as สำนักงานใหญ่ / Head Office.

---

### User Story 4 - Document presentation polish (Priority: P2)

Apply the customer's formatting revisions to all documents: thousands-separator commas on amounts; capitalized first letter of the English amount-in-words; buyer block reordered to **Name → Address → Tax ID → Head Office/Branch**; membership line description carrying the plan name + coverage period (e.g. "Swecham Premium Corporate Membership fee 2026 / Period: Jan–Dec 2026").

**Why this priority**: readability + customer-requested; applies uniformly via the shared document template.

**Independent Test**: render each document kind and confirm amounts are comma-grouped, the English words start uppercase, the buyer block order matches, and the membership line shows plan + period.

**Acceptance Scenarios**:

1. **Given** any document, **When** rendered, **Then** monetary figures use thousands separators (e.g. `12,000.00`) and the English amount-in-words begins with a capital letter.
2. **Given** a membership document, **Then** the line item reads as the plan name plus the coverage period.

---

### User Story 5 - Tenant-configurable footer + withholding-tax note (Priority: P2)

Remove the hardcoded "Rendered by Chamber-OS (§-citation)" footer and replace it with a **tenant-configurable** footer note. For TSCC, a withholding-tax note ("ค่าบำรุงสมาชิก … ผู้จ่ายไม่มีหน้าที่หักภาษี ณ ที่จ่าย", basis ม.65 ทวิ (13) + ท.ป.4/2528) renders on **membership documents only**. A tenant that configures no note renders nothing.

**Why this priority**: customer-requested footer change + multi-tenant correctness (the TSCC note must not be hardcoded and must not appear on event/sponsorship documents).

**Independent Test**: configure the note in tenant settings → confirm it renders on a membership document and NOT on an event document; a second tenant with no note configured shows a clean footer.

**Acceptance Scenarios**:

1. **Given** the tenant has configured a WHT note, **When** a membership document renders, **Then** the note appears in the footer and the old "Rendered by Chamber-OS" line and §-citation are gone.
2. **Given** the same tenant, **When** an event-fee document renders, **Then** the WHT note does **not** appear.
3. **Given** a tenant with no note configured, **Then** the footer renders with no stray note.

---

### User Story 6 - Credit notes target the tax receipt (Priority: P2)

A §86/10 ใบลดหนี้ must reference and annotate the **§86/4 tax receipt** (not the non-tax bill) and be issuable only after the receipt exists.

**Why this priority**: legal correctness for adjustments; the credit target must move with the tax document.

**Independent Test**: attempt to credit an unpaid bill (rejected); pay, then credit → the credit note references the RC receipt number and the credited annotation lands on the receipt.

**Acceptance Scenarios**:

1. **Given** an unpaid ใบแจ้งหนี้, **When** an admin attempts a credit note, **Then** it is rejected (no §86/4 tax document exists yet).
2. **Given** a paid membership with a tax receipt, **When** a credit note is issued, **Then** it references the receipt's RC number and the credited annotation is applied to the tax receipt document.

---

### User Story 7 - Event-fee flow parity, §105 unchanged (Priority: P3)

Event-with-TIN reuses the same non-tax ใบแจ้งหนี้ (when billed pre-payment) and the RC tax receipt at payment. Event-without-TIN is unchanged — a §105 ใบเสร็จรับเงิน issued at payment (as-paid). All event documents inherit the presentation polish.

**Why this priority**: keeps behaviour consistent and prevents a regression, but the membership path is the customer's focus.

**Acceptance Scenarios**:

1. **Given** an event attendee with a TIN billed before payment, **When** they pay, **Then** they receive the same ใบแจ้งหนี้ → RC tax-receipt flow as membership.
2. **Given** an event attendee without a TIN, **Then** they receive a §105 ใบเสร็จรับเงิน at payment exactly as today (legal identity unchanged), with the new presentation.

---

### Edge Cases

- An unpaid bill never consumes a §87 tax number; if it is never paid, the §87 tax-receipt register has no gap.
- Advance / partial / installment payment: each payment forms its own tax point → its own receipt. MVP handles a single full payment; multi-payment tax points are deferred.
- No-TIN individual member: still receives a §86/4 receipt at payment with the TIN line omitted (per 066); no Head Office/Branch line.
- Online (Stripe) payment where the receipt renders asynchronously must not mis-render the membership receipt as a §105-only document.
- Crediting while the receipt PDF is pending/failed is blocked until the receipt materialises.
- Buyer branch unknown (for a KNOWN VAT-registrant) → default สำนักงานใหญ่; issuance is never blocked on missing branch.
- Buyer legal-entity type unknown / NULL → treated as NOT a VAT registrant → no branch line at all (fail-closed, distinct from the "known registrant, unknown branch" case above).
- Renewal (F8) payment: a renewal-generated membership invoice follows the same ใบแจ้งหนี้ → RC-receipt flow (no §87 at issue; RC minted at renewal payment).
- Async receipt window: after online-payment success the receipt PDF may still be rendering → portal shows a "receipt being generated" state; a permanent render failure raises an admin alert + re-render path (FR-019).
- Voiding an **unpaid** ใบแจ้งหนี้ MUST succeed and re-render under the ใบแจ้งหนี้ title (never "Tax Invoice"), using the bill number (the row has no §87 number).
- A legacy invoice issued under the OLD flow (carries a §87 number, no bill number) presented for payment after cutover → payment blocked; void + re-issue required (FR-017).
- Voiding a **paid** membership stamps VOID on **both** blobs (bill + tax receipt) via the invoice- and receipt-PDF regeneration paths; a voided sale never leaves an un-stamped downloadable document. (Cancelling an issued §86/4 is normally a §86/10 credit note; void is the edge path.)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The pre-payment membership (and event-with-TIN) document MUST be a non-tax **ใบแจ้งหนี้ / Invoice** — no §86/4 title, no ต้นฉบับ marker, no §-citation — carrying its own **non-§87 sequential bill number**.
- **FR-002**: The **ใบกำกับภาษี / ใบเสร็จรับเงิน** (§86/4 + §105ทวิ) MUST be issued only at payment (offline record or online confirmation), **dated at the payment date** (Asia/Bangkok), with the §87 tax number allocated at that moment.
- **FR-003**: No §87 tax number MUST be consumed at billing; the bill-number series MUST be disjoint from the §87 tax series and MUST NOT participate in the tax-invoice uniqueness constraint.
- **FR-004**: The tax receipt MUST render **ต้นฉบับ (Original)** and **สำเนา (Copy)** as two pages in a single PDF sharing one document number and one stored artifact.
- **FR-005**: Online (Stripe card / PromptPay) and offline (admin-recorded) payment paths MUST produce identical tax-receipt content, kind, numbering, and dating.
- **FR-006**: Event-with-TIN MUST reuse the non-tax bill + payment-time RC tax receipt; event-without-TIN MUST remain a §105 ใบเสร็จรับเงิน issued at payment (unchanged legal identity).
- **FR-007**: Credit notes (§86/10) MUST reference and annotate the §86/4 tax receipt (not the non-tax bill) and MUST be issuable only after the tax receipt exists.
- **FR-008**: Seller and buyer §86/4 blocks MUST show a Head Office / Branch indicator on **both the ใบแจ้งหนี้ and the tax receipt**; buyer branch MUST be stored on the member record (admin-managed), default สำนักงานใหญ่, rendered only for VAT-registrant juristic buyers **via a juristic discriminator carried on the identity snapshot** — a buyer whose legal-entity type is individual / unknown / NULL renders **NO** branch line (fail-closed, never `buyerHasTin`); seller renders TSCC head office.
- **FR-009**: All documents MUST format monetary amounts with thousands separators and capitalize the first letter of the English amount-in-words (deterministic, locale-independent).
- **FR-010**: The buyer identity block order MUST be Name → Address → Tax ID → Head Office/Branch (member number and contact follow).
- **FR-011**: The membership line description MUST include the plan name and the coverage period.
- **FR-012**: The document footer MUST be tenant-configurable (replacing the hardcoded Chamber-OS / §-citation footer). The withholding-tax note MUST render on membership documents only — on **both the membership ใบแจ้งหนี้ and the membership tax receipt**, never on event documents — and be editable via tenant settings; a tenant with no configured note renders nothing.
- **FR-013**: The change MUST preserve tenant isolation (RLS), audit logging, and §87 no-gaps integrity on the tax-receipt stream.
- **FR-014**: All user-facing document and UI strings (PDF titles, admin, portal, i18n EN/TH/SV) MUST be updated so the pre-payment bill is never labelled ใบกำกับภาษี / Tax Invoice, with no missing-translation regressions.
- **FR-015**: After payment, **both** the ใบแจ้งหนี้ and the tax receipt MUST remain downloadable/accessible to admin and member (portal); the bill MUST NOT be hidden once paid.
- **FR-016** (two-document disambiguation): once paid, the admin + member portal MUST clearly distinguish the two documents — the ใบกำกับภาษี/ใบเสร็จรับเงิน (RC) labelled as the **tax receipt** (the accounting document; it carries a "Tax receipt" badge and is listed first in the document list) and the ใบแจ้งหนี้ (SC) marked as the **payable record — tax receipt issued (see the RC document)** — so a member knows which document is their tax receipt.
- **FR-017** (in-flight cutover guard): the payment path MUST reject payment of a legacy invoice that was §87-numbered under the old flow and lacks a bill number, forcing void + re-issue, so a single sale can never end with two §87 numbers (a duplicate §86/4). "Zero issued-unpaid invoices at cutover" is a verified operator gate.
- **FR-018** (renewal parity): the renewal (F8) flow MUST follow the same model — a renewal-generated membership invoice issues as a non-tax ใบแจ้งหนี้ (no §87), the RC tax receipt mints at renewal payment (online + offline), and renewal emails / success screens reference the correct documents.
- **FR-019** (paid member never stranded): a paid member MUST never be left without their §86/4 tax receipt — the async render window MUST show a "receipt being generated" state, and a permanent render failure MUST raise an admin alert (surfaced on the existing admin document/renewal alert channel) with an explicit re-render path. The re-render MUST reuse the existing F4 resend/re-render surface and MUST reuse the **same already-allocated RC number** (it re-renders from `receipt_document_number_raw` + the recorded payment date; it never allocates a fresh number, so SC-002 §87 gap-freeness holds) — an allocated RC number must always resolve to a rendered receipt.
- **FR-020** (all user-facing channels): FR-014's relabel MUST also cover transactional **email templates** (subjects + bodies) so a bill email never calls the document a Tax Invoice; the tax document travels on the receipt email (SC-005 surface).
- **FR-021** (audit evidence): the payment-time §86/4 tax-receipt issuance MUST emit a dedicated `tax_receipt_issued` audit event (10-year retention), distinct from the bill's `invoice_issued`, as the queryable evidence for SC-001 (one tax number per paid sale, born at payment).

### Key Entities *(include if feature involves data)*

- **ใบแจ้งหนี้ (Bill / Invoice)**: the non-tax pre-payment document; carries a bill number; no §87 obligation; not creditable.
- **ใบกำกับภาษี/ใบเสร็จรับเงิน (Tax Receipt)**: §86/4 + §105ทวิ; §87 number allocated at payment; renders Original + Copy; the creditable tax document.
- **§105 Receipt**: event-without-TIN receipt; issued at payment; unchanged.
- **Credit Note (ใบลดหนี้)**: §86/10; references the tax receipt.
- **Member**: gains a Head-Office / Branch attribute (indicator + optional 5-digit branch code), admin-managed, default head office.
- **Tenant Invoice Settings**: gains a configurable footer / withholding-tax note (TH + EN), seller head-office/branch, and the bill/receipt numbering configuration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every paid membership, exactly one §86/4 tax document exists (the payment-time receipt) and zero §86/4 documents are issued at billing.
- **SC-002**: The §87 tax-receipt number series has no gaps across mixed membership + event payments within a fiscal year.
- **SC-003**: The non-§87 bill-number series never appears in the tax-invoice uniqueness index and is visibly distinct from the tax series.
- **SC-004**: 100% of ใบกำกับภาษี/ใบเสร็จรับเงิน PDFs contain both an Original and a Copy page.
- **SC-005**: No user-facing surface (PDF, admin, portal, i18n, transactional email — subjects + bodies) labels the pre-payment bill as ใบกำกับภาษี / Tax Invoice.
- **SC-006**: Credit notes reference the tax-receipt number; attempting to credit an unpaid bill is rejected.
- **SC-007**: The withholding-tax note appears only on membership documents (never event) and only for the tenant that configured it.

## Assumptions

- ✅ **BUILD GATE (P1) — CLEARED (2026-07-01):** fact #1 (TSCC VAT-registered) is **CONFIRMED** — RD e-service (`eservice.rd.go.th/rd-ves-web`) shows Tax ID **0994000187203** (สำนักงานใหญ่ / Head Office), VAT-registered since **1992-01-20**; corroborated by TSCC's live invoice program (issues ใบกำกับภาษี + VAT 7% + ต้นฉบับ/สำเนา, matching this design). fact #2 (no volume-based tier) — TSCC fees are flat (Entrance / Registration / Sponsorship), OK. fact #3 (WHT membership-only) — resolved by best practice. **The §86/4 surfaces (US1 / US2 / US6) proceed.** (NB: the ID 0994000187203 is the RD tax ID on documents; the DBD juristic-reg number 0108533000013 is a different identifier and is NOT the VAT/tax ID.)
- **Confirmed §86/4 seller identity (seed `tenant_invoice_settings`, replaces the placeholder):** legal name TH `หอการค้าไทย-สวีเดน` / EN `Thai-Swedish Chamber of Commerce`; Tax ID `0994000187203`; `seller_is_head_office=true`, `seller_branch_code=NULL`; address `เลขที่ 34 ชั้น 4 ห้อง A04-420 อาคารซี.พี.ทาวเวอร์ 3 ถนนพญาไท แขวงทุ่งพญาไท เขตราชเทวี กรุงเทพมหานคร 10400` / `No.34, Level 4, Room A04-420, CP. Tower 3, Phaya Thai Rd., Thung Phayathai, Ratchathewi, Bangkok 10400`.
- 🔎 **VAT-0% / non-VAT variant (follow-up, surfaced from TSCC's live invoice program 2026-07-01):** the program has a per-invoice **"VAT / No VAT"** toggle + dedicated **"VAT 0%"** print sheets + a `Receipt_Only` marker — some transactions (e.g. certain foreign members / specific items) are issued **non-VAT / VAT-0%**. Membership is VAT 7% by default, but the redesign should confirm whether a **per-invoice VAT flag** (VATable vs non-VAT → plain §105 receipt) is in scope for this feature or a fast-follow. *Verify with the customer which cases are non-VAT.*
- Membership fees are **VATable services at 7%** and TSCC is a VAT registrant (RD ruling กค 0811/พ./2308). *Accountant to confirm TSCC's VAT-registration status.*
- **No withholding tax** on membership dues (ม.65 ทวิ (13) + ท.ป.4/2528; ruling กค 0811/8542). *Accountant to confirm no fee tier is tied to business volume (else §40(8) → withholding applies).*
- prod is **test-data only** (wiped 2026-06-24) → no byte-stable re-render / backward-compat constraint; a clean numbering cutover is acceptable.
- A single full payment per bill for MVP; advance / partial / installment tax-point handling is deferred.
- The §105 register for event-without-TIN may be kept separate (`RE`) or merged with `RC`; separate is the working default and is revisable per the accountant (not required by §87).

## Out of Scope

- e-Tax Invoice e-filing (XML) with RD — a later phase (branch-code hook designed in but not built).
- Per-invoice buyer-branch override UI (member-record value is authoritative for v1).
- Automated advance / installment tax-point issuance.

## Dependencies & Governance

- Constitution Principle I (two-layer tenant isolation), Principle IV (PCI DSS — the payment path now mints the tax receipt), and Thai-tax numbering (§87 no-gaps) all apply; the full Constitution Check runs at `/speckit.plan`.
- **Accountant / RD sign-off** on the tax assumptions above is a Review-gate blocker before ship.
