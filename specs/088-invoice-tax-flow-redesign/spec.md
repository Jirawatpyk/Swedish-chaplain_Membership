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
- Q: Does TSCC issue any §81-exempt "No VAT" documents, and how is the program's "VAT 0%" print sheet handled? → A: **No §81-exempt items exist** — every TSCC line is either **VAT 7% (standard)** or **VAT 0% (zero-rated §80/1(5))**. VAT 0% is **embassy / international-organization ONLY and case-by-case**: the embassy applies to the Ministry of Foreign Affairs (Protocol Dept), which issues a certificate the embassy hands to TSCC to attach; the embassy notifies TSCC per transaction. A zero-rated sale is still a **full §86/4 tax invoice at VAT 0%** (VATable-at-0%, creditable/reportable — NOT §81 exemption). **Membership is ALWAYS VAT 7%.** ⇒ This is folded into core 088 as **US8 (P3)** — per-invoice `vat_treatment` + MFA-certificate capture (fail-closed).
- Q: Is the MFA §80/1(5) certificate appended to the tax-invoice PDF or referenced? → A: **Referenced** — cert no./date printed on the document; the scan is retained separately in Vercel Blob, not appended to the PDF.

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
6. **Given** a draft membership invoice, **When** the admin opens the issue review step (FR-027), **Then** it surfaces the buyer + the Head-Office / Branch line that will print, the VAT treatment, the number stream (SC bill — no §87), and WHT-note presence, and requires an explicit acknowledgement that issuing pins an immutable tax snapshot; it WARNS when the bill would have no payment path or when the buyer's `legal_entity_type` is unset (no §86/4 branch line).
7. **Given** a membership bill that has just been paid, **Then** the member timeline shows a `tax_receipt_issued` entry linking the RC document and interpolating its `RC-…` number, while the earlier bill entry reads "ใบแจ้งหนี้ issued" — the payment moment is not confusingly doubled (FR-029 / SC-012).

---

### User Story 2 - Tax receipt renders Original + Copy (Priority: P1)

The ใบกำกับภาษี/ใบเสร็จรับเงิน must present both a **ต้นฉบับ (Original)** and a **สำเนา (Copy)** — satisfying §105ทวิ คู่ฉบับ and §87/3 retention.

**Why this priority**: a §86/4 tax receipt is incomplete without the copy pair; it ships with US1.

**Independent Test**: generate a payment-time receipt and confirm the single PDF contains two pages — page 1 marked ต้นฉบับ/ORIGINAL, page 2 marked สำเนา/COPY — sharing one document number.

**Acceptance Scenarios**:

1. **Given** a completed payment, **When** the tax receipt is generated, **Then** the resulting single PDF has two pages: an Original (ต้นฉบับ) and a Copy (สำเนา), both showing the same RC tax number.
2. **Given** a §86/4 tax receipt whose particulars (buyer name, line items, plan + period, notes) exceed one page, **When** the PDF is generated, **Then** the content wraps / paginates with no silent truncation (the buyer name is never clipped, no line is dropped) and the Original + Copy paginate consistently (FR-034).

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

### User Story 8 - Embassy / international-organization §80/1(5) VAT zero-rate (Priority: P3)

Sales of goods/services to **embassies / international organizations** (e.g., Embassy of Sweden — expo booth construction) are **zero-rated (0%) under Revenue Code §80/1(5)** — a full §86/4 tax invoice at VAT 0%, NOT a §81 exemption (still VATable-at-0%, input VAT claimable, reported as zero-rate sales on ภพ.30). The admin marks a **non-membership** invoice as zero-rated **case-by-case** at issue, captures the **Ministry of Foreign Affairs (Protocol Dept) certificate** the embassy supplies, and the payment-time §86/4 tax receipt renders VAT 0% with a **§80/1(5) note** + certificate reference. **Membership is ALWAYS VAT 7%.**

**Why this priority**: P3 — it applies only to occasional embassy/int'l-org sales and does not touch the core membership flow (US1–US6); it ships after the core is correct. Legal basis: RD-approved certificates **VAT 326-24 / 327-24 / 351-24** (MFA Protocol Dept) for the Thai-Swedish Chamber.

**Independent Test**: issue a non-membership (event/service) invoice with `vat_treatment = zero_rated_80_1_5` and an MFA certificate number/date → confirm the bill and payment-time §86/4 tax receipt compute VAT at 0% (vat_amount 0), the receipt carries the §80/1(5) note + certificate reference; then attempt a zero-rated invoice with no certificate number → confirm it is blocked; then confirm a membership invoice cannot be set to zero-rated and stays VAT 7%.

**Acceptance Scenarios**:

1. **Given** a non-membership (event/service) sale to an embassy / int'l organization, **When** an admin issues it as `zero_rated_80_1_5` with an MFA certificate number + date, **Then** the ใบแจ้งหนี้ shows VAT 0% / 0.00 with total = base, the treatment is pinned into the immutable issue-time snapshot, and the `invoice_issued` audit payload records `vat_treatment` + `zero_rate_cert_no`.
2. **Given** an attempt to issue a `zero_rated_80_1_5` invoice with a NULL `zero_rate_cert_no`, **When** the admin submits, **Then** issuance is **blocked** (fail-closed); a purchase below ~5,000 baht is **warned** (not hard-blocked).
3. **Given** a paid zero-rated embassy invoice, **When** the tax receipt is issued at payment, **Then** it is a **full §86/4 tax invoice at VAT 0%** carrying the **§80/1(5) note** ("VAT 0% under §80/1(5); MFA certificate no. …") + the certificate reference/attachment, renders Original + Copy unchanged, and the `tax_receipt_issued` audit payload records `vat_treatment` + `zero_rate_cert_no`.
4. **Given** a membership invoice, **When** an admin attempts to set it to `zero_rated_80_1_5`, **Then** it is rejected — membership rows stay `standard` (VAT 7%) and the WHT note (FR-012) still applies while the §80/1(5) note does not render.
5. **Given** a zero-rated (`zero_rated_80_1_5`) embassy bill whose §86/4 tax receipt is rendered on the **async** path, **When** the PDF is generated, **Then** it computes **VAT 0%** and renders the **§80/1(5) note** (the async worker sources the pinned `vat_treatment` + cert, never defaults to 7%).
6. **Given** a **membership** invoice in the issue form, **When** the admin opens it, **Then** the `vat_treatment` toggle is **hidden or disabled** with a caption ("Membership is always VAT 7%"), and any forced / API attempt to set `zero_rated_80_1_5` is **rejected with 422 `membership_cannot_be_zero_rated`** (reject, not silent coerce).
7. **Given** a non-membership invoice, **When** the admin selects `zero_rated_80_1_5`, **Then** the MFA-certificate fields **progressively reveal** (hidden until selected), the cert-number field is dynamically marked required, and the reveal is **announced via `aria-live`**; the control carries a readable label + help ("embassy / int'l-org only; attach the MFA certificate").
8. **Given** a zero-rated invoice being composed, **When** the admin leaves `zero_rate_cert_no` empty and tries to submit, **Then** **inline client validation blocks submit** (cert field `aria-invalid` + `role="alert"` message, localised EN/TH/SV) before any server round-trip; and **When** the subtotal is below ~5,000 baht, **Then** an **inline localised warn** appears before submit (not a hard block).
9. **Given** the admin attaches an MFA-certificate scan, **When** the upload runs, **Then** the UI enforces accepted type / size, shows loading / progress + error states, makes clear the scan is optional (the cert **NUMBER** is the fail-closed gate), and the file is **malware-scanned (ClamAV)** before it is retained.
10. **Given** a zero-rated invoice whose issue fails, **When** the admin retries, **Then** the entered `vat_treatment` + certificate no. / date + the already-ClamAV-scanned cert scan are preserved and no re-upload is required; and **When** the admin switches the treatment `zero_rated` → `standard` → `zero_rated`, **Then** the certificate fields RESET (no stale cert data carries over) (FR-033).

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
- Async receipt window: after online-payment success the receipt PDF may still be rendering → portal shows a "receipt being generated" state (aria-live, auto-revalidating, with reassurance that the tax point is already recorded); a permanent render failure shows the member a **graceful state with a contact-support affordance** (never an infinite spinner) and raises an admin alert + re-render path (FR-019).
- Voiding an **unpaid** ใบแจ้งหนี้ MUST succeed and re-render under the ใบแจ้งหนี้ title (never "Tax Invoice"), using the bill number (the row has no §87 number).
- A legacy invoice issued under the OLD flow (carries a §87 number, no bill number) presented for payment after cutover → payment blocked; void + re-issue required (FR-017).
- Voiding a **paid** membership stamps VOID on **both** blobs (bill + tax receipt) via the invoice- and receipt-PDF regeneration paths; a voided sale never leaves an un-stamped downloadable document. (Cancelling an issued §86/4 is normally a §86/10 credit note; void is the edge path.)
- **Dirty issue form / cert reset**: switching a zero-rated invoice back to `standard` and again to `zero_rated_80_1_5` RESETS the certificate fields (no stale cert no. / date / scan carries over); a failed issue instead PRESERVES the entered treatment + cert no. / date + the already-scanned blob for retry without re-uploading; an abandoned or superseded ClamAV-scanned cert blob is swept on a TTL (F4 error-rows-CSV precedent); navigating away from a dirty issue form triggers a `beforeunload` / route-change guard. (FR-033)
- **Bill with no payment path**: issuing a bill while online-pay is OFF and the offline bank block is empty MUST **warn on the pre-issue review** (the member would receive a payable with no way to pay); issuance is not hard-blocked, but the admin must acknowledge. (FR-027)
- **Buyer `legal_entity_type` unset at issue (ongoing, post-cutover)**: the pre-issue review WARNS that **no §86/4 Head-Office / Branch line will print** because the buyer's legal-entity type is unset — an **ongoing** guard (not only a one-time cutover check), distinct from the "known VAT-registrant, unknown branch → default สำนักงานใหญ่" case above. (FR-027)
- **§86/4 particulars overflow**: when the buyer name, line items, plan + period, or notes exceed one page they MUST **wrap / paginate** — a truncated buyer name or a dropped line item is non-compliant — and the Original + Copy pages paginate consistently. (FR-034)
- **Concurrent stale-write on a bill**: a second admin (or a stale tab) recording payment / voiding an already-paid / already-voided bill MUST get an **inline "already paid / voided — refresh" (HTTP 409)**, never a raw error or a duplicate §87 allocation. (FR-032)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The pre-payment membership (and event-with-TIN) document MUST be a non-tax **ใบแจ้งหนี้ / Invoice** — no §86/4 title, no ต้นฉบับ marker, no §-citation — carrying its own **non-§87 sequential bill number**.
- **FR-002**: The **ใบกำกับภาษี / ใบเสร็จรับเงิน** (§86/4 + §105ทวิ) MUST be issued only at payment (offline record or online confirmation), **dated at the payment date** (Asia/Bangkok), with the §87 tax number allocated at that moment.
- **FR-003**: No §87 tax number MUST be consumed at billing; the bill-number series MUST be disjoint from the §87 tax series and MUST NOT participate in the tax-invoice uniqueness constraint.
- **FR-004**: The tax receipt MUST render **ต้นฉบับ (Original)** and **สำเนา (Copy)** as two pages in a single PDF sharing one document number and one stored artifact.
- **FR-005**: Online (Stripe card / PromptPay) and offline (admin-recorded) payment paths MUST produce identical tax-receipt content, kind, numbering, and dating.
- **FR-006**: Event-with-TIN MUST reuse the non-tax bill + payment-time RC tax receipt; event-without-TIN MUST remain a §105 ใบเสร็จรับเงิน issued at payment (unchanged legal identity).
- **FR-007**: Credit notes (§86/10) MUST reference and annotate the §86/4 tax receipt (not the non-tax bill) and MUST be issuable only after the tax receipt exists.
- **FR-008**: Seller and buyer §86/4 blocks MUST show a Head Office / Branch indicator on **both the ใบแจ้งหนี้ and the tax receipt**; buyer branch MUST be stored on the member record (admin-managed), default สำนักงานใหญ่, rendered only for VAT-registrant juristic buyers **via a juristic discriminator carried on the identity snapshot** — a buyer whose legal-entity type is individual / unknown / NULL renders **NO** branch line (fail-closed, never `buyerHasTin`); seller renders TSCC head office. The admin member-record branch input MUST surface an **inline cross-field validation error** when the branch data is inconsistent with the buyer type (e.g. a branch code set on an individual / non-registrant buyer), and the **branch line that will print** (สำนักงานใหญ่ vs สาขาที่ NNNNN) MUST be shown on the issue preview so the admin sees it before issuing. (The NULL / unset `legal_entity_type` warn on that issue preview is folded into **FR-027**'s pre-issue review — see FR-027.)
- **FR-009**: All documents MUST format monetary amounts with thousands separators and capitalize the first letter of the English amount-in-words (deterministic, locale-independent). Document dates MUST format **per locale** (**BE display-only for `th-TH`**; storage stays Gregorian ISO 8601 UTC), and long Thai notes / names MUST **wrap and are NEVER clipped** on the PDF or the 320px list.
- **FR-010**: The buyer identity block order MUST be Name → Address → Tax ID → Head Office/Branch (member number and contact follow).
- **FR-011**: The membership line description MUST include the plan name and the coverage period.
- **FR-012**: The document footer MUST be tenant-configurable (replacing the hardcoded Chamber-OS / §-citation footer). The withholding-tax note MUST render on membership documents only — on **both the membership ใบแจ้งหนี้ and the membership tax receipt**, never on event documents — and be editable via tenant settings; a tenant with no configured note renders nothing.
- **FR-013**: The change MUST preserve tenant isolation (RLS), audit logging, and §87 no-gaps integrity on the tax-receipt stream.
- **FR-014**: All user-facing document and UI strings (PDF titles, admin, portal, i18n EN/TH/SV) MUST be updated so the pre-payment bill is never labelled ใบกำกับภาษี / Tax Invoice, with no missing-translation regressions.
- **FR-015**: After payment, **both** the ใบแจ้งหนี้ and the tax receipt MUST remain downloadable/accessible to admin and member (portal); the bill MUST NOT be hidden once paid.
- **FR-016** (two-document disambiguation): the admin + member portal MUST clearly distinguish the bill from the tax receipt using **localised (EN/TH/SV) text-badges — never colour-only** (WCAG 1.4.1: the document state MUST be conveyed by accessible text, not hue alone).
  - The ใบกำกับภาษี/ใบเสร็จรับเงิน (RC) MUST carry a **"Tax receipt"** text-badge (the accounting document) and be listed first in the document list once it exists.
  - The ใบแจ้งหนี้ (SC) label MUST be **conditional on payment state**: while **issued / unpaid** it reads **"Invoice / payable record" ONLY** — it MUST NEVER claim "tax receipt issued" before an RC exists; once **paid** it adds **"tax receipt issued — see the RC document"**.
  - The "see the RC document" reference MUST be a **clickable cross-reference** (a link / anchor to the RC row/document), not plain text, so a member can jump straight to their tax receipt.
  - All badge + label strings MUST have EN/TH/SV keys and remain accessible as text (no colour-only signalling).
  - The badges + labels MUST also render on the **invoice detail-page header** (not only list rows), and MUST **reuse the shipped `StatusBadge` / `Badge` variant** (no new badge component).
  - Each document control MUST carry an **accessible name (kind + number)**, and the "see RC" cross-reference MUST **name its target** ("see tax receipt RC-…").
- **FR-017** (in-flight cutover guard): the payment path MUST reject payment of a legacy invoice that was §87-numbered under the old flow and lacks a bill number, forcing void + re-issue, so a single sale can never end with two §87 numbers (a duplicate §86/4). "Zero issued-unpaid invoices at cutover" is a verified operator gate.
- **FR-018** (renewal parity): the renewal (F8) flow MUST follow the same model — a renewal-generated membership invoice issues as a non-tax ใบแจ้งหนี้ (no §87), the RC tax receipt mints at renewal payment (online + offline), and renewal emails / success screens reference the correct documents.
- **FR-019** (paid member never stranded): a paid member MUST never be left without their §86/4 tax receipt.
  - **Async render window (member-facing)**: the portal MUST show a **"receipt being generated"** state with **reassurance copy** that the tax point is already recorded (e.g. "RC-… issued, tax point recorded — your PDF is being prepared"), MUST **announce the state via `aria-live`** (polite region), and MUST **auto-refresh / revalidate when the PDF is ready** so the member never has to manually reload — it MUST NOT show an indefinite spinner.
  - **Permanent render failure (member-facing)**: the member MUST see a **graceful state with a contact-support affordance** (never an infinite spinner or a dead end), while the failure ALSO raises an admin alert (surfaced on the existing admin document/renewal alert channel) with an explicit re-render path. The admin permanent-fail alert surface MUST be concrete — an **inline alert-state row on the admin invoices / documents list** plus **the existing admin notification surface**; admin rows MUST show a **shimmer "receipt generating"** state while a receipt is pending, and all such indicators MUST respect `prefers-reduced-motion` (pulse fallback).
  - **Re-render**: MUST reuse the existing F4 resend/re-render surface and the **same already-allocated RC number** (it re-renders from `receipt_document_number_raw` + the recorded payment date; it never allocates a fresh number, so SC-002 §87 gap-freeness holds) — an allocated RC number must always resolve to a rendered receipt.
- **FR-020** (all user-facing channels): FR-014's relabel MUST also cover transactional **email templates** (subjects + bodies) so a bill email never calls the document a Tax Invoice; the tax document travels on the receipt email (SC-005 surface).
- **FR-021** (audit evidence): the payment-time §86/4 tax-receipt issuance MUST emit a dedicated `tax_receipt_issued` audit event (10-year retention), distinct from the bill's `invoice_issued`, as the queryable evidence for SC-001 (one tax number per paid sale, born at payment).
- **FR-022** (offline-payment bank block): the **ใบแจ้งหนี้** MUST render a tenant-configurable **bank / payment-instructions block** for offline payment (bank transfer / cheque). **DECIDED model = STRUCTURED fields** (matches data-model § F.7, not one free-text blob): `bank_payee_name`, `bank_account_no`, `bank_account_type`, `bank_name`, `bank_branch`, `bank_address`, `bank_swift` **plus a free-text instructions line (`payment_instructions_th` / `_en`)** (e.g. cheque "Account Payee Only"; all bank fees borne by the payer). The settings form for these fields MUST apply **format validation** (SWIFT/BIC pattern, account-number format), **help text**, **char counters**, and **EN/TH/SV labels**. Tenant-configurable (empty → not rendered); rendered on the ใบแจ้งหนี้ (the document the member pays against), **not** on the paid tax receipt. The document also carries an **"Issued by"** (preparer) name — **auto-filled from the acting admin's display name and pinned into the issue-time snapshot** — and blank **"Received by" / "Date"** signature-stamp fields that stay blank for the wet signature (layout elements).
- **FR-023** (per-invoice VAT treatment): each invoice MUST carry a **`vat_treatment`** attribute — default **`standard`** (VAT 7%) or **`zero_rated_80_1_5`** (VAT 0%, §80/1(5) embassy / int'l-org zero-rate) — set by an admin at issue **case-by-case** (per-invoice, NOT per-member). The chosen treatment MUST be **pinned into the immutable issue-time snapshot**. Membership invoices MUST remain `standard` (a membership row can never be zero-rated); zero-rate applies only to non-membership (event/service) embassy/int'l-org sales.
  - **Error-prevention UI (membership)**: on a **membership** invoice the `vat_treatment` toggle MUST be **hidden or disabled** with a short explanatory caption (e.g. "Membership is always VAT 7%") so the invalid state cannot be reached from the UI.
  - **Defense-in-depth (server)**: a zero-rate-on-membership request MUST be **REJECTED** with **422 `membership_cannot_be_zero_rated`** — a **reject, NOT a silent coerce** — backed by a DB CHECK; UI-prevention + 422 + CHECK are three defense-in-depth layers (shared decision 1).
- **FR-024** (MFA-certificate capture, fail-closed): a `zero_rated_80_1_5` invoice MUST capture the **Ministry of Foreign Affairs (Protocol Dept) certificate** the embassy supplies — `zero_rate_cert_no` (the MFA note number, e.g. กต 0404/…), `zero_rate_cert_date`, and an optional attached scan `zero_rate_cert_blob_key` (Vercel Blob, reusing the F4 invoice-PDF blob adapter).
  - **Fail-closed (defense-in-depth)**: a `zero_rated_80_1_5` invoice with a NULL `zero_rate_cert_no` MUST be caught by **inline client-side validation before submit** (the cert-number field marked `aria-invalid`, wired via `aria-describedby` to a `role="alert"` message, localised EN/TH/SV); the server **422 `zero_rate_cert_required`** + the DB CHECK are the second and third layers (shared decision 2).
  - **Discoverability + progressive disclosure**: the `vat_treatment` control MUST have a readable label + help text ("embassy / int'l-org only; attach the MFA certificate"); the cert fields MUST be **revealed only when `zero_rated_80_1_5` is selected** (progressive disclosure), with **dynamic required-marking** on the cert-number field and an **`aria-live` announcement on reveal** so assistive tech is notified.
  - **≥ 5,000 baht warn (inline)**: because the subtotal is known in the form, the low-amount advisory MUST surface **inline before submit** (localised EN/TH/SV) as a **warn (not a hard block)** — not only after issuance.
  - **Cert-scan upload**: the optional `zero_rate_cert_blob_key` upload MUST specify **accepted file type + size**, show **loading / progress** and an **error state**, make clear it is **optional (the cert NUMBER is the fail-closed gate, not the scan)**, and MUST be **malware-scanned (ClamAV, per the F7.1a image-upload pattern)** before it is retained.
  - **Input ergonomics + focus (mobile-first)**: the cert-scan upload's PRIMARY input MUST be a **native "Choose file" button** (per FR-036; drag / drop is an enhancement only); on an inline-validation block, **focus MUST move to the first invalid field**; the revealed cert fields MUST enter the tab order **immediately after the toggle** with a **visible focus ring**; and the inputs MUST carry mobile keyboard hints (cert-no, `branch_code` numeric max 5, SWIFT characters, account-no digits).
- **FR-025** (zero-rate rendering + computation): a `zero_rated_80_1_5` sale MUST compute **vat_rate 0% / vat_amount 0** as a **VATable-at-0% supply** (creditable/reportable — NOT §81 exemption). The ใบแจ้งหนี้ MUST show VAT 0% / 0.00 with total = base; the payment-time §86/4 tax invoice/receipt MUST be a **full §86/4 tax invoice at VAT 0%** carrying a **§80/1(5) note** ("VAT 0% under §80/1(5); MFA certificate no. …") + the certificate reference/attachment, with Original + Copy unchanged. `standard` MUST compute VAT 7% as today; the WHT note (FR-012) does not render on zero-rated sales, and the §80/1(5) note does not render on membership. `vat_treatment` (+ `zero_rate_cert_no`) MUST be captured in the `invoice_issued` and `tax_receipt_issued` audit payloads (no separate event needed).
- **FR-026** (settings-form UX): saving tenant invoice settings MUST give clear feedback — a **success toast** on save. Changing the **receipt prefix or numbering mode (RC)** MUST additionally require a **confirmation dialog that explains the §87 continuity impact** (a prefix / mode change affects the gap-free tax-receipt stream and must be a deliberate, acknowledged action) before it is applied; all other settings saves use the standard save toast. The settings form (bank block FR-022, footer / WHT note FR-012, seller identity, numbering config) MUST meet the a11y bar of SC-010 and the i18n parity of SC-009.
- **FR-027** (pre-issue review / confirm): Before issuing, the admin MUST see a **review step** that surfaces the buyer + the **Head-Office / Branch line that will print**, the **VAT treatment (visually prominent when zero-rated 0%)**, the certificate no. / date, the totals, the **number stream (SC bill — no §87)**, and **WHT-note presence**, with an **explicit acknowledgement that issue PINS an immutable tax snapshot** (editable only by void). The review MUST also **WARN** when (a) the bill will render with **no payment path** (online-pay off AND the bank block empty), and (b) **no §86/4 branch line will print because the buyer's `legal_entity_type` is unset** (ongoing post-cutover guard). This absorbs FR-008's branch preview.
- **FR-028** (§87-mint mutation contract): record-payment / any §87-minting action MUST use the **money-mutation modal** (ux § 6.4 — spinner, dialog stays open until success / failure, **NO optimistic close, NO undo toast**). Optimistic-UI + undo-toast are **FORBIDDEN** on any §87-minting mutation (never reuse the shipped bulk-mark-paid optimistic / undo pattern here).
- **FR-029** (member timeline): the member timeline MUST render the new **`tax_receipt_issued`** event (link the RC document + interpolate the `RC-…` number; keys `admin.members.timeline.taxReceiptIssued` EN/TH/SV); the existing `invoiceIssued` timeline copy MUST be reworded to **"ใบแจ้งหนี้ issued"**; the timeline MUST render paid + tax-receipt so the payment moment is **not confusingly doubled**. FR-014's relabel scope explicitly includes `admin.members.timeline.*`.
- **FR-030** (document_number-NULL sweep): every outstanding / AR (F9 dashboard), at-risk (F8 `invoicesOverdueCount`), and member-detail invoice surface MUST count + label an issued ใบแจ้งหนี้ via **`status` + `bill_document_number_raw`**, **NEVER `document_number`** (which is NULL until payment). Regression-tested + post-cutover verified.
- **FR-031** (admin list filters + period views): the admin invoice list MUST gain filters (**document type SC / RC / RE / CN · payment-tax-point state · `vat_treatment`**) + a **period view** surfacing the §86/4 RC §87 register and the §80/1(5) **zero-rate sales list** (ภพ.30 support). Saved-segments / bulk-export are a follow-on.
- **FR-032** (uniform action feedback): issue / pay / re-render / credit / void MUST emit **doc-specific success toasts** (EN/TH/SV — issue → "ใบแจ้งหนี้ SC-… issued", pay → "Tax receipt RC-… issued", etc.); **irreversible / tax-mutation FAILURES** MUST route to an **inline `role="alert"` (focused), not a transient toast**. A concurrent stale-write (HTTP 409) MUST show an **inline "already paid / voided — refresh"**, not a raw error.
- **FR-033** (issue-failure recovery + dirty-state): a failed issue MUST **PRESERVE** the entered `vat_treatment` + cert no. / date + the already-ClamAV-scanned `zero_rate_cert_blob_key` and offer **retry WITHOUT re-uploading**; switching `zero_rated` → `standard` → `zero_rated` MUST **RESET** the cert fields; an abandoned / superseded scanned cert blob MUST get a **TTL sweep** (F4 error-rows-CSV precedent); a dirty issue form MUST have a **`beforeunload` / route-change guard**.
- **FR-034** (§86/4 pagination, no silent truncation): the §86/4 particulars (buyer name, line items, plan + period, notes) MUST **wrap / paginate** and MUST **NEVER be silently truncated** (a truncated buyer name / dropped line is non-compliant); **Original + Copy paginate consistently** on overflow.
- **FR-035** (palette + per-row + undo-on-issue-only): the command palette MUST gain admin actions **"Record payment for …"** (deep-link `?pay=1`) + **"Re-render tax receipt"**; issued bills MUST gain a **per-row "Record payment"** quick action (defaults today / bank-transfer); a **toast-with-undo (10s)** MUST appear after **ISSUE only** (revert to draft — no §87 consumed). Undo / optimistic MUST **NEVER** apply on record-payment. An optional bulk record-payment MUST mint **one RC per invoice sequentially in-tx, gap-free, and is NOT undoable**. Keys `admin.commandPalette.invoices.*` EN/TH/SV.
- **FR-036** (mobile-first responsive): the 4 new surfaces (admin issue form, settings form, portal 2-doc list, portal pending state) MUST render at **320px with no horizontal scroll**; all new controls MUST have **touch targets ≥ 44×44px (≥ 24 min)**; the portal per-row PDF view / download control MUST be **≥ 44px + `aria-label` (kind + number) + a `download` filename encoding the kind**, and Original + Copy MUST be **one file that opens on iOS Safari + Android Chrome**; the cert upload's PRIMARY input MUST be a **native "Choose file" button** (keyboard-focusable, ≥ 44px; drag / drop = enhancement); the settings form MUST group fields with **`<fieldset><legend>`** + a **reachable / sticky Save at 320px**.

### Key Entities *(include if feature involves data)*

- **ใบแจ้งหนี้ (Bill / Invoice)**: the non-tax pre-payment document; carries a bill number; no §87 obligation; not creditable.
- **ใบกำกับภาษี/ใบเสร็จรับเงิน (Tax Receipt)**: §86/4 + §105ทวิ; §87 number allocated at payment; renders Original + Copy; the creditable tax document.
- **§105 Receipt**: event-without-TIN receipt; issued at payment; unchanged.
- **Credit Note (ใบลดหนี้)**: §86/10; references the tax receipt.
- **Member**: gains a Head-Office / Branch attribute (indicator + optional 5-digit branch code), admin-managed, default head office.
- **Tenant Invoice Settings**: gains a configurable footer / withholding-tax note (TH + EN), seller head-office/branch, the bill/receipt numbering configuration, and the **structured offline-payment bank block** (FR-022 structured fields + free-text instruction line). Editing the receipt prefix / numbering mode is gated by a §87-continuity confirmation dialog (FR-026).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every paid membership, exactly one §86/4 tax document exists (the payment-time receipt) and zero §86/4 documents are issued at billing.
- **SC-002**: The §87 tax-receipt number series has no gaps across mixed membership + event payments within a fiscal year.
- **SC-003**: The non-§87 bill-number series never appears in the tax-invoice uniqueness index and is visibly distinct from the tax series.
- **SC-004**: 100% of ใบกำกับภาษี/ใบเสร็จรับเงิน PDFs contain both an Original and a Copy page.
- **SC-005**: No user-facing surface (PDF, admin, portal, i18n, transactional email — subjects + bodies) labels the pre-payment bill as ใบกำกับภาษี / Tax Invoice.
- **SC-006**: Credit notes reference the tax-receipt number; attempting to credit an unpaid bill is rejected.
- **SC-007**: The withholding-tax note appears only on membership documents (never event) and only for the tenant that configured it.
- **SC-008**: A zero-rated embassy / int'l-org sale issues a **full §86/4 tax invoice at VAT 0%** with a captured MFA certificate (no./date), charging **no 7% VAT** — and a `zero_rated_80_1_5` invoice with no MFA certificate number is blocked; membership invoices stay VAT 7%.
- **SC-009** (i18n parity): every new **interactive** string introduced by this feature — not just the PDF / email strings of FR-014 / FR-020, but the `vat_treatment` toggle + caption, the cert labels / help / errors, the inline ≥ 5,000 warn, the "Tax receipt" badge, the payable-record label, the "receipt being generated" copy, the admin re-render alert, the settings help + §87-continuity confirmation copy, and the bank-block labels — has **EN/TH/SV parity** with no missing-translation regressions. The SV strategy for Thai tax terms (e.g. สำนักงานใหญ่, §80/1(5)) is **keep-Thai-plus-gloss** (the Thai tax term with a parenthetical Swedish gloss), applied consistently — **pinned, not deferred**.
- **SC-010** (a11y): the new surfaces — the issue-invoice form (incl. the `vat_treatment` toggle + progressively-disclosed cert fields), the portal two-document disambiguation, the async "receipt being generated" pending state, and the tenant settings form — pass **axe-core WCAG 2.1 AA** with keyboard / focus operability and `aria-live` announcements for dynamic reveals + the pending state, asserted via an explicit `@a11y` E2E check (not just generic e2e). The `@a11y` gate MUST additionally assert **WCAG 1.4.10 Reflow / 1.4.4 Resize Text 200% / 2.5.5 Target Size** (axe alone does not cover these).
- **SC-011** (mobile, measurable): all 4 new surfaces render at **320 / 375px** with `document.scrollWidth ≤ innerWidth` (no horizontal scroll) and **every new control ≥ 44px** — asserted in the `@a11y` / responsive E2E (T072a).
- **SC-012** (timeline + AR, measurable): after payment the member timeline shows a **`tax_receipt_issued`** entry carrying the **RC number**, AND the F9 AR / F8 at-risk / member-detail surfaces count **issued-unpaid ใบแจ้งหนี้** correctly (via `status` + bill number) — regression-tested.

## Assumptions

- ✅ **BUILD GATE (P1) — CLEARED (2026-07-01):** fact #1 (TSCC VAT-registered) is **CONFIRMED** — RD e-service (`eservice.rd.go.th/rd-ves-web`) shows Tax ID **0994000187203** (สำนักงานใหญ่ / Head Office), VAT-registered since **1992-01-20**; corroborated by TSCC's live invoice program (issues ใบกำกับภาษี + VAT 7% + ต้นฉบับ/สำเนา, matching this design). fact #2 (no volume-based tier) — TSCC fees are flat (Entrance / Registration / Sponsorship), OK. fact #3 (WHT membership-only) — resolved by best practice. **The §86/4 surfaces (US1 / US2 / US6) proceed.** (NB: the ID 0994000187203 is the RD tax ID on documents; the DBD juristic-reg number 0108533000013 is a different identifier and is NOT the VAT/tax ID.)
- **Confirmed §86/4 seller identity (seed `tenant_invoice_settings`, replaces the placeholder):** legal name TH `หอการค้าไทย-สวีเดน` / EN `Thai-Swedish Chamber of Commerce`; Tax ID `0994000187203`; `seller_is_head_office=true`, `seller_branch_code=NULL`; address `เลขที่ 34 ชั้น 4 ห้อง A04-420 อาคารซี.พี.ทาวเวอร์ 3 ถนนพญาไท แขวงทุ่งพญาไท เขตราชเทวี กรุงเทพมหานคร 10400` / `No.34, Level 4, Room A04-420, CP. Tower 3, Phaya Thai Rd., Thung Phayathai, Ratchathewi, Bangkok 10400`.
- 🔎 **VAT-0% variant = §80/1(5) zero-rate for embassy / int'l-org sales (ANSWERED 2026-07-01, from RD-approved certificates VAT 326-24/327-24/351-24):** the program's "VAT / No VAT" toggle + "VAT 0%" print sheets are for **zero-rated (0%) sales under §80/1(5)** — NOT VAT-exempt (§81) — to **embassies / international organizations** (e.g., Embassy of Sweden: expo booth construction). Still a **§86/4 tax invoice with VAT at 0%**, requires a **Ministry of Foreign Affairs (Protocol Dept) certificate** attached (each purchase ≥ 5,000 baht; copy filed with ภพ.30). **Membership is ALWAYS VAT 7% — the core is unaffected.** ⇒ The §80/1(5) zero-rate path (per-invoice 0% VAT rate + MFA-certificate capture, for non-membership embassy/int'l-org sales) is **IN SCOPE for core 088 as US8 (P3)** — see FR-023 / FR-024 / FR-025 + SC-008. **Accountant confirmed 2026-07-01:** TSCC has **NO true "No VAT" (§81-exempt) items** — every line is either **VAT 7%** or **VAT 0%**. VAT 0% is **embassy-only and case-by-case**: the embassy applies to the Ministry of Foreign Affairs, which issues a certificate the embassy hands to TSCC to attach; **the embassy notifies TSCC per transaction**. So the zero-rate path = a per-invoice `vat_treatment` toggle (default `standard`) + MFA-certificate capture (fail-closed; ≥ 5,000 baht warn), **embassy sales only → US8 (P3), after the core membership flow.**
- **TSCC bank/payment block (FR-022 seed data, from the live ใบแจ้งหนี้):** Payee `Thai-Swedish Chamber of Commerce` · A/C `005-3-92003-9` (Savings) · `Kasikorn Bank, Emquartier Branch` (Emquartier Bldg, 3rd Fl 3C04, Sukhumvit 35, Sukhumvit Rd, Wattana, Klongtan Nua, Bangkok 10110) · SWIFT `KASITHBK` · "If you pay by cheque, make it 'Account Payee Only'. All bank fees to be covered by the payer." These are **tenant-configurable settings fields** (like the WHT note), NOT hardcoded. (Modelling: structured bank fields + a free-text instruction line vs one free-text block — a design choice for `/speckit.plan` follow-up.)
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
