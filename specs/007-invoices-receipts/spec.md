# Feature Specification: F4 — Membership Invoicing & Thai-Tax Receipts

**Feature Branch**: `007-invoices-receipts`
**Created**: 2026-04-18
**Status**: Draft
**Input**: User description: "F4 Invoices & receipts"

## Context

F4 is the Phase 1 "finish line" for replacing the Excel workbook: once admins
can draft and issue a membership invoice, record payment, issue credit notes
when needed, and auto-deliver Thai-tax-compliant PDFs, the organisation no
longer needs Excel for day-to-day membership operations. Online payment
(Stripe + PromptPay) is a **separate feature (F5)** and is out of scope here
— payment is recorded manually by admins.

Tenant-scoped per SaaS architecture (`docs/saas-architecture.md`). Each tenant
configures its own VAT rate, registration fee, tax ID, legal entity name, and
invoice/receipt numbering format. Sensitivity: **⚠ Finance** — full audit trail
required (Constitution Principle VIII).

**Why built in-house** (build vs. buy): Chamber-OS is the system of record for
members, tiers, pro-rate policies, and benefit quotas. Third-party billing SaaS
(QuickBooks / Xero / FreshBooks Thai) would require bidirectional sync of member
+ tier data, add a cross-border transfer of PII, and gate the tier-based pricing
logic (pro-rate, registration fee for new members, partnership-tier bundles)
behind limited third-party data models. The cost of building the PDF engine +
sequential-number allocator in-house is amortised across F5 (Stripe online
payment), F8 (renewal reminders + at-risk detection), and F9 (audit viewer + GDPR
export) — all of which need the invoice state machine as their source of truth.

## Clarifications

### Session 2026-04-18

- Q: How does the generated PDF reach the member when admin issues an invoice or records a payment? → A: Auto-email on issue + on payment + on credit-note issuance, with a manual "resend PDF" action for admins.
- Q: How is the invoice due date set, and what happens when it passes without payment? → A: Tenant-configured default net-N days (e.g. net-30) with per-invoice admin override; system auto-derives an `overdue` status when `today > due_date AND status = issued`.
- Q: How should sequential tax-document number assignment relate to PDF generation so Thai RD §87 "no gaps" is guaranteed? → A: Fully transactional — sequential number assignment, PDF rendering, and DB persistence all run inside one unit of work; any failure rolls back and the number is never consumed.
- Q: Is there a persisted "draft" stage before issuance, or is issuance one-click atomic? → A: Persisted draft stage — admins create/edit/delete drafts freely (no sequential number, no PDF); an explicit "Issue" action commits the sequential tax number, renders the PDF, and makes the invoice immutable.
- Q: How long are tax documents retained, and what happens when the associated member is archived or GDPR-deleted? → A: 10-year retention from issue date (covers Thai RD §87/3 + 7-year extensions + buffer). Tax documents are immune to member archive/delete — they retain their snapshotted legal identity and survive member lifecycle changes under GDPR/PDPA "legal obligation" basis.

### Session 2026-04-18 (round 2 — post-critique)

- Q: Does SweCham currently use combined (ใบกำกับภาษี/ใบเสร็จรับเงิน) or separate tax-invoice + receipt? → A: **Combined** by default (Thai SMB norm; simpler bookkeeper workflow; one PDF stamped with payment info on mark-paid). `tenant_invoice_settings.receipt_numbering_mode` defaults to `combined`; tenants whose filing practice requires separate streams can opt-in.
- Q: Is SC-008 ("Admin support tickets for PDF resend drop ≥80%") measurable without a baseline? → A: No — softened to a binary outcome: "in the first month after F4 ship, no PDF-resend admin workload is reported in the monthly retrospective." Measured by asking the SweCham admin in a 1-question retro check-in.
- Q: Auto-email on every issue/payment/credit-note — is it always on? → A: No, admins can turn it off per-invoice at draft time (`auto_email_on_issue` boolean, defaults to tenant setting). Useful when admin expects to reissue or wants to batch-review before delivery.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Admin issues a Thai-tax-compliant membership invoice (Priority: P1)

Admin staff pick a member, confirm the membership tier and period, and the system
generates a draft invoice with the correct line items (membership fee, registration
fee for new members, pro-rated if mid-year), applies the tenant's VAT rate,
assigns the next sequential tax-document number, and produces a bilingual
(Thai + English) PDF that satisfies Thai Revenue Department (RD) requirements.

**Why this priority**: Without a legal tax invoice the organisation cannot collect
money from Thai corporate members — VAT-registered companies legally require
a Thai tax invoice (ใบกำกับภาษี) to pay.

**Independent Test**: Seed a member + tier. Admin clicks "Issue invoice",
confirms the preview, issues. The issued invoice appears in the invoice list
with a sequential number, a PDF downloads, the PDF matches the Thai RD required
fields, and an audit entry records the issuance. No payment step needed.

**Acceptance Scenarios**:

1. **Given** an active member on a corporate tier and a tenant with VAT 7% configured, **When** admin issues a full-year invoice dated 2026-01-15, **Then** the invoice contains one membership-fee line, one registration-fee line (if the member is new this cycle), VAT 7% applied to the subtotal, a sequential invoice number unique within the tenant and year, and the PDF displays in Thai with English translations for every label.
2. **Given** a new member joining mid-cycle on 2026-07-15 with the tenant's pro-rate policy enabled, **When** admin issues the invoice, **Then** the membership fee line is pro-rated for the remaining cycle, the line description reflects the pro-rate period, and the subtotal reflects the reduced amount before VAT.
3. **Given** an issued invoice, **When** admin opens the invoice detail page, **Then** the PDF download button produces a file bearing the tenant's legal name, tenant tax ID, member's legal name + tax ID, itemised lines, VAT subtotal + total, issue date in CE format (with BE shown in parentheses for the Thai-locale rendering), the sequential tax-invoice number, and an unambiguous "ใบกำกับภาษี / Tax Invoice" label.
4. **Given** a manager role (read-only on finance), **When** they open the invoice list, **Then** they can view and download PDFs but cannot issue, edit, or void any invoice — all mutating controls are disabled and any direct-route access returns a not-authorised response.
5. **Given** a draft invoice, **When** admin clicks "Preview PDF", **Then** a watermarked PDF ("DRAFT / ร่าง — NOT A TAX DOCUMENT") downloads showing the final layout using the production template pipeline, **without** consuming a sequential number and **without** persisting to Blob. No audit event for the preview. Admin can iterate on the draft freely before committing.
6. **Given** a mix of drafts and issued invoices across statuses, **When** admin opens the invoice list landing page, **Then** drafts are excluded by default; drafts are accessible via a clearly-labelled "Drafts" tab or filter pill with a count badge. This prevents drafts from polluting financial-review screens.

---

### User Story 2 — Admin records payment and issues a tax receipt (Priority: P1)

Admin marks an issued invoice as paid by recording payment method, payment date,
reference (bank transfer slip, cheque number, cash receipt number), and optional
notes. The system transitions the invoice to "paid", produces a Thai-tax-compliant
receipt PDF (ใบเสร็จรับเงิน), and writes an immutable audit entry.

**Why this priority**: A paid invoice without a legal receipt is useless to a
corporate member's bookkeeper. Manual payment + receipt is the F4 workflow
because online payment (F5) is a later feature.

**Independent Test**: Create an issued invoice from US1. Admin clicks "Record
payment", fills method + date + reference, confirms. Status flips to paid, a
receipt PDF downloads, the invoice list reflects paid status, and the audit
trail contains a `invoice_paid` event linking the admin, the invoice, the
reference, and the amount.

**Acceptance Scenarios**:

1. **Given** an issued invoice for THB 53,500 (incl. VAT), **When** admin records payment via bank transfer dated 2026-01-20 with reference `SCB-20260120-4421`, **Then** the invoice status becomes paid, the payment date + method + reference are persisted, and the receipt PDF renders a valid Thai-tax-compliant receipt with a new sequential receipt number.
2. **Given** a paid invoice, **When** any authorised user downloads its PDF, **Then** the document is labelled "ใบเสร็จรับเงิน / Official Receipt" (or the tenant-configured combined "ใบกำกับภาษี/ใบเสร็จรับเงิน" per its RD filing) and includes the payment date, method, and reference in both Thai and English.
3. **Given** a paid invoice, **When** admin attempts to mark it paid again, **Then** the action is rejected with a clear message (idempotent; already paid) and no duplicate audit entry or receipt is created.
4. **Given** that partial payments are out of scope for F4 (see Assumptions), the UI MUST NOT expose partial-payment affordances.

---

### User Story 3 — Member views invoices and downloads PDFs in the portal (Priority: P2)

A signed-in member sees their company's invoices on the member portal, filtered
to their own tenant + company, with status, amount, issue date, and a PDF
download for each. They cannot edit, void, or issue anything — view + download
only.

**Why this priority**: Reduces admin support load ("please resend the invoice
PDF") and gives members self-service access to their tax documents, which is a
commonly requested convenience and a prerequisite for F5 online renewal. Not
P1 because admin-side issuance + manual delivery (email) is already a complete
workflow; this is an enhancement over the admin-only flow.

**Independent Test**: Seed an issued invoice for a member's company. Sign in as
that member, open the portal invoices page, verify the invoice appears, click
download, verify the PDF matches the admin-rendered PDF byte-for-byte.

**Acceptance Scenarios**:

1. **Given** a signed-in member whose company has 3 issued invoices (2 paid, 1 open), **When** they open the portal invoices page, **Then** they see all 3 rows with status, amount, issue/due/paid dates, and download buttons.
2. **Given** a member signed in to tenant A, **When** they attempt to access an invoice belonging to tenant B via a crafted URL, **Then** the system returns a not-found response and records a cross-tenant-probe audit event (per Constitution Principle I tenant isolation).
3. **Given** a member with no invoices yet, **When** they open the portal invoices page, **Then** they see a helpful empty state explaining that invoices will appear once issued.

---

### User Story 4 — Admin configures tenant invoice settings (Priority: P2)

A tenant admin configures: VAT rate, registration fee amount, legal entity name
(Thai + English), tax ID, registered address, invoice + receipt numbering format
(default `combined` / optional `separate` streams), reset cadence, pro-rate
policy, default net-days for due date, and optional logo for the PDF header
(uploaded via a separate dedicated logo-upload endpoint with MIME + size +
dimension validation, PNG/JPEG only).

**Why this priority (upgraded from P3 to P2 post-critique)**: FR-010 refuses any
invoice issuance if required settings are missing — the settings form is a hard
prerequisite, not a later enhancement. The original P3 justification relied on a
"seeded once" operational workaround that would leave any second tenant (or any
VAT-rate change) dependent on developer intervention. Shipping the minimal
settings form alongside US1 + US2 is a ~15-field form using existing F3 form
primitives; the cost is small compared to the operational risk of deferring.

**Independent Test**: As tenant admin, open tenant settings → Invoicing, change
VAT from 7.0% to 10.0%, save. Issue a new invoice — VAT calculation uses 10.0%.
Existing issued invoices are unchanged (VAT rate is snapshotted at issue time).

**Acceptance Scenarios**:

1. **Given** tenant settings with VAT 7.0%, **When** admin updates to 10.0% and saves, **Then** future invoices use 10.0% and previously issued invoices retain their snapshotted 7.0%.
2. **Given** a tenant without a configured tax ID or legal name, **When** admin attempts to issue an invoice, **Then** the system refuses and surfaces a clear setup-incomplete error, explaining which required fields are missing.
3. **Given** the "yearly reset" numbering policy, **When** the clock crosses into a new fiscal year and the first invoice is issued, **Then** the sequence restarts at 1 (within its year-partitioned key) without colliding with the previous year's numbers.
4. **Given** admin uploads a logo, **When** the upload completes, **Then** the system accepts only PNG or JPEG (MIME whitelist), size ≤ 1 MB, dimensions within 200×100…2000×500 px; on accept, the image is re-encoded via `sharp` to strip EXIF/metadata before storage; SVG + any other MIME is rejected with a clear error. Only after a successful upload can the returned `logo_blob_key` be referenced in the PATCH settings endpoint.
5. **Given** a tenant without a `tenant_invoice_settings` row yet (first-ever admin access), **When** an admin navigates to `/admin/invoices` or tries to create a draft, **Then** an empty-state card displays "Finish invoice setup to start billing" with a primary CTA button "Configure Invoicing" linking to `/admin/settings/invoicing`; draft creation + issuance are blocked with the same message until at least all required settings fields are populated.

---

### User Story 5 — Admin voids an invoice (Priority: P3)

Admin can mark an **issued but unpaid** invoice as void (wrong amount, wrong
member, cancelled membership) with a required reason. A void is terminal — the
invoice keeps its sequential tax number (never reused), the PDF is reissued
stamped "VOID / ยกเลิก", and an audit entry records who voided it and why.
Paid invoices cannot be voided — use the credit-note flow (US6) instead.

**Why this priority**: Mistakes happen. Without a void path, admins would have to
keep incorrect invoices on record, which corrupts financial reporting. But it's
P3 because the mistake rate on a small-volume workflow is low; manual workarounds
suffice on day 1.

**Independent Test**: Issue an invoice. As admin, void it with reason "Wrong
tier selected". Confirm the invoice list shows "Void" status, the PDF is
re-stamped, the tax-invoice number is not reissued to the next invoice, and the
audit trail contains a `invoice_voided` event with the reason.

**Acceptance Scenarios**:

1. **Given** an issued unpaid invoice, **When** admin voids it with a reason, **Then** status becomes void, the PDF shows a VOID stamp in both languages, and the next-issued invoice takes the next sequential number (the voided one's number is retired, not reused).
2. **Given** a paid invoice, **When** admin attempts to void it, **Then** the action is rejected with a clear message directing them to the credit-note workflow (US6).
3. **Given** a voided invoice, **When** admin attempts any further action on it (mark paid, re-void, edit), **Then** all such actions are rejected — void is terminal.
4. **Given** admin voids an issued invoice with `auto_email_on_issue` at default (true), **When** void commits, **Then** the member's primary billing contact receives a bilingual (TH+EN) cancellation email within 1 minute referencing the original document number, the void reason, and an explicit "this document is no longer payable" statement.

---

### User Story 6 — Admin issues a credit note against a paid invoice (Priority: P2)

Admin issues a formal credit note (ใบลดหนี้ / Credit Note) against a paid
invoice when a refund, adjustment, or tier downgrade is needed. The credit
note has its own sequential tax-document number, references the original
invoice, recalculates VAT proportionally, produces a bilingual PDF that
satisfies Thai Revenue Department requirements, and transitions the
original invoice to a terminal "credited" or "partially credited" state.

**Why this priority**: Real-world refunds, tier corrections, and membership
cancellations happen — without a Thai-RD-compliant credit-note workflow,
admins have to handle each case manually offline, which breaks the audit
trail and the bookkeeper experience. P2 because it's less frequent than
issuance+payment (US1+US2), but it's a hard legal requirement whenever a
paid invoice needs adjustment.

**Independent Test**: Issue + pay an invoice (via US1+US2). Admin clicks
"Issue credit note", picks full or partial amount, enters a reason, confirms.
A bilingual credit-note PDF downloads, the original invoice shows "credited"
status, the credit note gets its own sequential number, and the audit trail
contains a `credit_note_issued` event linking both documents.

**Acceptance Scenarios**:

1. **Given** a paid invoice for THB 53,500 incl. VAT, **When** admin issues a full credit note with reason "Membership cancelled mid-year", **Then** a new credit-note document is created with its own sequential tax number, VAT is recalculated proportionally, the original invoice transitions to "credited", and the credit-note PDF is labelled "ใบลดหนี้ / Credit Note" and includes a reference to the original invoice number and date.
2. **Given** a paid invoice for THB 53,500, **When** admin issues a partial credit note for THB 10,700, **Then** the original invoice transitions to "partially credited", a subsequent partial credit note can be issued for up to the remaining THB 42,800, and any attempt to credit more than the remaining balance is rejected with a clear message.
3. **Given** an unpaid invoice, **When** admin attempts to issue a credit note against it, **Then** the action is rejected with a message directing them to void instead (US5).
4. **Given** a credited or partially-credited invoice, **When** any user downloads the original invoice PDF, **Then** it still renders with its original content (numbers, lines, totals) but with a non-destructive annotation indicating which credit notes reference it. **Implementation** (Phase 6 Tier 2): on `applyCreditNoteRollup` the invoice PDF is re-rendered with a diagonal "CREDITED / ลดหนี้แล้ว" (terminal) or "PARTIALLY CREDITED / ลดหนี้บางส่วน" (ongoing) overlay plus a footer table listing referencing CN numbers, dates, and amounts. Re-render uses the invoice's PINNED `pdf_template_version` (FR-016 layout-integrity guarantee). The Blob object is overwritten at the original content-addressed key; `pdf_sha256` on the invoice row is updated to match (the `invoices_immutable` trigger explicitly whitelists `pdf_sha256` for this kind of re-render); an `invoice_pdf_regenerated` audit row captures before/after sha256 + `triggered_by_credit_note_id`. Mirrors the FR-008 VOID-stamping pattern.

---

### User Story 7 — Invoice history on member page + F3 timeline integration (Priority: P2)

Admin opens any member's detail page (the F3 surface) and sees the full
invoice history for that member in a dedicated section: drafts, issued,
paid, voided, credited — sortable, filterable by status + year, with
quick actions (view PDF, record payment, issue credit note). In addition,
every financially significant event on the member's invoices (draft
created, issued, paid, voided, credit note issued, PDF resent) MUST appear
chronologically in the F3 member timeline alongside existing member events,
so the timeline reflects the complete member lifecycle.

**Why this priority**: Without this, admins have to jump between the member
page and the invoice list to reconstruct a member's billing history — which
is the single most common question during a renewal conversation ("when did
they last pay? are they current?"). The F3 timeline was explicitly designed
to be the unified member history, and leaving F4 events out of it breaks
that promise. P2 because US1 + US2 already give a working issuance +
payment flow; US7 is the glue that makes F3 and F4 feel like one product.

**Independent Test**: Seed a member with 2 issued + 1 paid invoice and 1
credit note via US1/US2/US6. Open the member detail page. Verify the
invoice-history section shows all 4 documents with correct statuses and
quick actions. Verify the F3 timeline shows: `invoice_issued` × 2,
`invoice_paid` × 1, `credit_note_issued` × 1 — correctly ordered with
existing member events.

**Acceptance Scenarios**:

1. **Given** a member with invoices across multiple years and statuses, **When** admin opens the member detail page, **Then** an "Invoices" section renders all of that member's invoices (drafts + issued + paid + voided + credited) with status chips, totals, issue/due/paid dates, and per-row quick actions appropriate to status (view PDF, record payment, issue credit note, void).
2. **Given** the same member, **When** admin opens the F3 timeline tab, **Then** every F4 event (`invoice_draft_created`, `invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`, `invoice_pdf_resent`) appears chronologically alongside existing F3 events with clear labels, actor, and a click-through to the corresponding document.
3. **Given** a manager role (read-only), **When** they open the member page, **Then** the invoice-history section is visible and filterable but all mutating quick actions are hidden or disabled.
4. **Given** a `member` role (self-service), **When** they open their own portal landing page, **Then** a compact invoice-history summary (latest 3 + "view all" link) is visible — this is a read-only surface that links into US3's full list.

---

### Edge Cases

- **Clock skew at year boundary**: if two admins issue invoices simultaneously across midnight on Dec 31 → Jan 1, numbering must assign each to the correct fiscal year and never produce a duplicate sequential number within a year.
- **PDF rendering failure mid-issue**: if the PDF engine throws (font missing, out of memory, template bug), the sequential number assignment MUST roll back so no gap is left in the Thai-RD-mandated sequence. Admins see a clear error and may retry.
- **Very long legal names** (Thai + English + parenthetical) must not overflow the PDF header or break the tax-RD-required layout.
- **Zero-amount invoice** (e.g., complimentary tier): system must still produce a valid tax invoice with a THB 0.00 total — some bookkeepers require this.
- **Unusual characters** in member legal names (diacritics, mixed scripts) must render correctly in the PDF.
- **Member deleted/archived** after invoice issued: the invoice remains, PDF still renders with a snapshot of the member's name + address at issue time.
- **VAT rate change after issue, before payment**: invoice uses the issue-time rate (snapshotted); no recalculation at payment.
- **Cross-tenant access attempts** (member of tenant A trying to view invoice of tenant B) must be blocked at both application and database layers.
- **Idempotent download**: clicking Download PDF multiple times produces the same file bytes (deterministic PDF generation) to support user bookmarking and email forwarding.
- **Reduced-motion**: all toasts, skeletons, and state transitions must respect `prefers-reduced-motion` per `docs/ux-standards.md`.

## Requirements *(mandatory)*

### Functional Requirements

**Core issuance & payment**

- **FR-001**: System MUST allow admins to create and edit **draft** invoices for a member on a selected tier, for a selected period. A draft has no sequential tax-invoice number, no rendered PDF, is fully editable, and can be deleted without an audit footprint on the tax-document sequence (but the delete action itself IS audited). An explicit **Issue** action transitions draft → issued: the system assigns the next sequential tax-invoice number, snapshots tenant + member identity and pricing, renders the bilingual PDF, triggers auto-email (FR-024, unless per-invoice `auto_email_on_issue = false`), and thereafter the invoice is immutable.
- **FR-001a**: System MUST support a watermarked draft-PDF preview action on any draft. The preview (a) renders using the production template pipeline for layout parity, (b) stamps a clear "DRAFT / ร่าง — NOT A TAX DOCUMENT" watermark, (c) does NOT allocate a sequential number, (d) does NOT persist to Blob, (e) does NOT write an audit event, (f) is streamed directly to the requesting admin. This closes the "point of no return" UX gap without compromising FR-003 (transactional issuance).
- **FR-002**: System MUST calculate the invoice total as (membership fee × pro-rate factor) + (registration fee if the member is new this cycle) + VAT, using the tenant's current settings snapshotted at issue time.
- **FR-003**: System MUST assign a sequential tax-invoice number unique within the tenant and the fiscal year and never reuse a retired number (voided invoices keep their number). Sequential number assignment, PDF rendering, and database persistence for any tax document (invoice, receipt, credit note) MUST occur within a single transaction — if PDF rendering or persistence fails for any reason, the transaction MUST roll back and the number MUST NOT be consumed. This structural guarantee satisfies Thai RD §87 (no gaps in sequential tax-document numbering).
- **FR-004**: System MUST generate a PDF for every invoice and every receipt that satisfies Thai Revenue Department requirements: tenant legal name + tax ID + registered address, customer legal name + tax ID (if corporate) + address, line items with unit + quantity + price, subtotal + VAT + total, document label ("ใบกำกับภาษี / Tax Invoice" or "ใบเสร็จรับเงิน / Official Receipt"), issue date, sequential document number. The PDF MUST be bilingual (Thai primary + English) at minimum.
- **FR-005**: System MUST display monetary amounts in THB as primary currency across UI and PDFs, with thousand separators and two decimal places.
- **FR-006**: System MUST allow admins to record a payment against an issued invoice: method (bank transfer / cheque / cash / other), payment date, reference string, optional notes. Recording payment MUST transition status to paid and generate a receipt PDF.
- **FR-007**: System MUST refuse to mark an invoice paid more than once (idempotent on the second attempt with a clear conflict message).
- **FR-008**: System MUST allow admins to void an issued but unpaid invoice with a required reason; a voided invoice is terminal. Voiding a paid invoice MUST be refused (directs user to the credit-note workflow per FR-020 … FR-023). The voided invoice's PDF MUST be re-rendered with a bilingual "VOID / ยกเลิก" diagonal overlay at approximately 45° across the page centre, semi-transparent (40-60% opacity) so the original content remains legible, on every page of the document. The overlay is added at render time using the `void-stamped-invoice-template.tsx` variant and replaces the original Blob at the same content-addressed key (same `pdf_template_version`).

**Configuration**

- **FR-009**: System MUST expose per-tenant invoice configuration: VAT rate (%), registration fee amount, legal entity name (TH + EN), tax ID, registered address (TH + EN), invoice/receipt numbering format (default `combined` / optional `separate`), numbering reset cadence, pro-rate policy, default net-days for due date, default `auto_email_on_issue` boolean, and optional logo. Logo upload MUST go through a dedicated endpoint that enforces MIME whitelist (image/png, image/jpeg — SVG explicitly rejected), size ≤ 1 MB, dimensions within 200×100…2000×500 px, and re-encodes via a server-side image processor to strip EXIF/metadata before persisting.
- **FR-010**: System MUST refuse to issue any invoice if the tenant's mandatory invoice configuration is incomplete, explaining which fields are missing.
- **FR-011**: System MUST snapshot VAT rate, registration fee, tenant legal name + tax ID + address, and member legal name + tax ID + address on the invoice at issue time. Subsequent edits to tenant or member settings MUST NOT alter past invoices.

**Access, authorisation, tenant isolation**

- **FR-012**: Only users with `admin` role in the tenant MAY issue, record payment on, or void invoices. `manager` role is strictly read-only. `member` role may view + download PDFs only for invoices belonging to their own company.
- **FR-013**: System MUST enforce tenant isolation at both application and database layers per Constitution Principle I — a user of tenant A MUST NOT access any invoice of tenant B by any route (UI, API, direct database query). A cross-tenant access attempt MUST be logged as an audit event.
- **FR-014**: Members MUST be able to list their company's invoices and download the PDFs from the member portal.

**Audit & reliability**

- **FR-015**: System MUST write an append-only audit entry for each of: invoice created, invoice issued, invoice paid, invoice voided, credit note issued, tenant invoice-settings changed, cross-tenant probe. Audit entries MUST include the acting user, tenant, invoice (if applicable), timestamp (UTC), and a stable event-specific payload. Audit entries MUST NOT be mutable or deletable.
- **FR-016**: System MUST guarantee that **downloading the same issued invoice** returns byte-identical content for the lifetime of the document (Thai RC §87/3 = 5 years minimum). **Source-of-truth principle**: the issued PDF is persisted to content-addressable storage (Vercel Blob) at issue time; subsequent downloads stream the stored bytes verbatim — never re-render. The render pipeline itself is also pinned for determinism (`Math.random` + `Date` stubbed during render — see `infrastructure/pdf/deterministic-render.ts`) as defense-in-depth, but is not the load-bearing guarantee. Auto-rerender on Blob outage (R3-E4) MUST emit `invoice_pdf_regenerated` audit so the trail records any byte change for forensic / compliance review.
- **FR-017**: System MUST store timestamps as ISO 8601 UTC (Gregorian). Thai Buddhist Era (BE) MUST be display-only on the `th-TH` surface. Mixing BE into storage is a defect.
- **FR-018**: System MUST support SV + EN + TH locale rendering for all non-PDF admin and member UI; the PDF MUST render Thai + English regardless of the viewer's locale (tax documents are locale-independent for Thai RD purposes).

**Cross-feature integration (F3 member page + timeline)**

- **FR-032**: System MUST render a dedicated "Invoices" section on each member's detail page (F3 surface) that lists all invoices (all statuses, all years) for that member, with status, dates, totals, and per-row quick actions gated by role (admin: full; manager: view + download; member: view + download own).
- **FR-033**: System MUST emit every financially significant F4 event — `invoice_draft_created`, `invoice_issued`, `invoice_paid`, `invoice_voided`, `credit_note_issued`, `invoice_pdf_resent` — into the F3 member timeline as first-class timeline entries with actor, timestamp, summary, and a link to the underlying document. Timeline entries MUST respect the same tenant-isolation and role-visibility rules as the invoices themselves.

**Retention & lifecycle interaction**

- **FR-029**: System MUST retain every issued invoice, receipt, and credit note (with its rendered PDF and snapshotted tenant+member identity) for **10 years** from its issue date. This covers Thai Revenue Code §87/3 (5-year minimum), typical 7-year audit extensions, and a safety buffer.
- **FR-030**: Tax documents MUST be immune to member lifecycle changes: archiving or deleting a member (including GDPR / PDPA "right to erasure" requests) MUST NOT delete or alter the member's invoices, receipts, or credit notes, because the tenant has a legal obligation (Thai RD + GDPR Art. 6(1)(c) / PDPA equivalent) to keep them. Snapshotted member identity on the tax document is the legal record; live member profile changes do not affect past documents.
- **FR-031**: GDPR / PDPA data-access, export, and erasure workflows (handled in F9) MUST treat tax documents as a distinct retention category governed by legal obligation and MUST surface them as such in member-facing data exports.

**Logo upload endpoint (security-critical — FR-009 enforcement)**

- **FR-034**: Tenant logo upload MUST go through a dedicated `POST /api/tenant-invoice-settings/logo` endpoint that accepts multipart upload, enforces: (a) MIME ∈ `{image/png, image/jpeg}` — any other MIME rejected; (b) size ≤ 1 MB; (c) dimensions 200 ≤ width ≤ 2000 AND 100 ≤ height ≤ 500; (d) re-encode via server-side image processor (e.g. `sharp`) to strip EXIF / metadata / embedded scripts before persistence to Blob. The returned `logo_blob_key` is the only value acceptable in the subsequent `PATCH /api/tenant-invoice-settings` body — the PATCH endpoint MUST NOT accept raw logo binary data.

**Document-number format overflow guard**

- **FR-035**: Sequential tax-document numbering MUST enforce a Domain-level invariant that the allocated `sequence_number` fits the configured 6-digit zero-padded format. On overflow (N > 999,999 within a fiscal year), the issue transaction MUST fail with an actionable error directing the operator to the documented runbook; it MUST NOT silently wrap, truncate, or emit a malformed document number.

**Void cancellation notification**

- **FR-036**: System MUST automatically email the member's primary billing contact a bilingual (TH+EN) cancellation notice when an issued invoice is voided, subject to the per-invoice `auto_email_on_issue` flag (symmetric override with issuance/payment auto-emails). The notice MUST reference the original document number, state the void reason, and explicitly declare "This document is no longer payable / เอกสารฉบับนี้ยกเลิกแล้ว". The email MUST include the **VOID-stamped invoice PDF** (same template with VOID/ยกเลิก overlay) as an attachment so the bookkeeper has a filing-complete cancellation record matching the original invoice they already filed. Delivered via a new outbox event type `invoice_voided_notice` through the same outbox pipeline (FR-024, FR-026).

**Member state check on issue**

- **FR-037**: The issue transaction (FR-003) MUST acquire a row-level lock on the target member (`SELECT … FOR UPDATE`) and verify `member.status = 'active'` before allocating a sequence number. Attempting to issue an invoice for an archived member MUST fail with a clear "Member is archived — undelete first" error. This prevents a race with a concurrent archive-member operation from leaving an invoice orphaned against an archived owner.

**Tax-ID snapshot semantics (receipts and credit notes)**

- **FR-038**: Receipts and credit notes MUST render the member tax identity (`tax_id`, legal name, address) **as snapshotted on the original invoice at issue time** — NOT as it appears on the live member record at payment or credit-note time. Rationale: Thai Revenue Department audits invoice + receipt + credit note as a single document chain with consistent payer identity (legal continuity). If a member's tax_id changes mid-cycle, admin must void the invoice + reissue under the new identity, or consult Thai RD guidance.

**UX requirements (post-checklist-gap resolution)**

- **FR-039**: The Preview and Issue actions on a draft invoice MUST be visually and semantically distinct: Preview is a secondary-styled button (outline/ghost) with label "Preview PDF" + icon indicating a read-only action; Issue is a primary-styled button (solid, prominent colour) with label "Issue Invoice" and a destructive-class typed-phrase confirmation dialog. Preview MUST NOT appear in the same button group as Issue without a visual separator.
- **FR-040**: Every destructive or irreversible F4 action — Issue (consumes sequence number), Void (terminal), Credit Note issuance (creates a new tax document) — MUST require a typed-phrase confirmation dialog. The typed phrase MUST be the invoice's document number (or "ISSUE" / "VOID" / "CREDIT" in the absence of a document number on draft→issue) so the confirmation is locale-independent and cannot be accidentally bypassed.
- **FR-041**: PDF download interactions MUST behave correctly on mobile browsers — iOS Safari MUST trigger the native share / save-to-Files sheet; Chrome Android MUST trigger the browser download; both MUST NOT open the PDF inline in an iframe that blocks the member from returning to the app (common anti-pattern). Achieved via `Content-Disposition: attachment; filename=…` with a deterministic filename format `{document_number}.pdf`.
- **FR-042**: Every new admin + member layout introduced by F4 MUST include a skip-to-content link and ARIA landmark roles (`main`, `navigation`, `complementary` as applicable) matching the F1+F3 layout pattern. The skip-to-content link MUST be keyboard-reachable as the first tab-stop and visible on focus.

**Pro-rate policy**

- **FR-019**: System MUST support a configurable pro-rate policy with three options per tenant: **none** (full-period fee regardless of join date), **monthly** (fee × (months remaining in cycle) ÷ (total months in cycle), with a defined rounding rule for partial months), and **daily** (fee × (days remaining in cycle) ÷ (days in cycle)). The chosen option MUST be snapshotted on every issued invoice so that later policy changes do not alter historic documents.

**Due date & overdue**

- **FR-027**: System MUST compute each invoice's default due date as `issue_date + tenant.default_net_days` (tenant-configured, e.g. 30). Admins MAY override the due date per invoice at issuance time. The due date MUST be snapshotted on the invoice and not auto-recomputed if the tenant setting later changes.
- **FR-028**: System MUST auto-derive an `overdue` state for any invoice where `current_date > due_date` AND `status = issued` (i.e., unpaid past its due date). `overdue` is a derived view of the `issued` status, not a stored terminal state; recording payment or voiding returns the invoice to its correct explicit status. `overdue` invoices MUST be visually distinguished in admin and member UIs.

**Delivery**

- **FR-024**: System MUST automatically email the generated PDF to the member's primary billing contact(s) upon (a) invoice issuance, (b) payment recording, and (c) credit-note issuance. The email MUST be bilingual (Thai + English) and include the PDF as an attachment. Auto-email on issue MAY be overridden per-invoice at draft time via an `auto_email_on_issue` boolean that defaults to the tenant's setting; when false, admin can still manually resend later via FR-025.
- **FR-025**: System MUST allow admins to manually resend any previously generated PDF to one or more recipients at any time, recording each resend as an audit event (`invoice_pdf_resent`, `receipt_pdf_resent`, `credit_note_pdf_resent`) with the recipient list and acting admin.
- **FR-026**: If automatic email delivery fails (bounce, rejection, provider outage), the system MUST surface the failure to admins on the invoice detail page with a clear action to retry or edit the recipient, and MUST NOT roll back the underlying state transition (issuance / payment / credit-note) — delivery is decoupled from the financial event.

**Credit notes / refunds**

- **FR-020**: System MUST support issuing a formal credit note (ใบลดหนี้ / Credit Note) against a paid invoice, with its own sequential tax-document number unique within tenant + fiscal year, a required reason, the original invoice linked, the partial or full amount being credited, VAT recalculated proportionally, and a bilingual (Thai + English) PDF that satisfies Thai Revenue Department requirements for credit notes.
- **FR-021**: A credit note MUST transition the original invoice into a terminal "credited" or "partially credited" state and MUST NOT alter the original invoice's snapshotted tax-invoice number, line items, or PDF — the credit note is a separate tax document that references the original.
- **FR-022**: System MUST refuse to issue a credit note if the referenced invoice is not in a "paid" state (unpaid invoices use the void path per FR-008) or if the requested credit amount exceeds the invoice total minus previously issued credits against it.
- **FR-023**: System MUST write an append-only audit entry (`credit_note_issued`) for each credit note, including the acting admin, the original invoice, the credit amount, the reason, and the resulting credit-note document number.

### Key Entities

- **Invoice**: A membership invoice created by a tenant for a member for a billing period. Has a status (draft / issued / paid / void / credited / partially_credited; derived: overdue when issued-past-due_date). A draft is editable and has no sequential tax number or PDF; on issuance it acquires a sequential tax-invoice number (unique per tenant per year), a snapshotted VAT rate, snapshotted tenant+member identity, snapshotted pro-rate policy, a rendered immutable PDF, a currency (default THB), line items, issue date, and due date. Payment details are added on payment.
- **Invoice Line**: A single billable item on an invoice — a membership-fee line or a registration-fee line, with unit description (TH + EN), quantity, unit price, pro-rate factor (if applicable), and line total.
- **Payment Record**: Attached to an invoice on mark-paid. Captures method, date, reference string, notes, and the admin who recorded it. Used to generate the tax receipt.
- **Receipt**: A tax-compliant PDF document generated when an invoice is paid. Has its own sequential receipt number (may be the same as the invoice number when the tenant uses a combined "tax invoice/receipt" format, or independent if separate). Immutable once generated.
- **Credit Note**: A Thai-RD-compliant tax document (ใบลดหนี้) issued against a paid invoice. Has its own sequential tax-document number unique per tenant per fiscal year, references exactly one original invoice, captures a reason, amount credited, VAT recalculation, and the admin who issued it. An original invoice may have multiple partial credit notes up to its total value. Immutable once issued.
- **Void Record**: Attached to an invoice on void. Captures reason, voider, timestamp. The invoice retains its sequential number but is marked VOID in all rendering.
- **Tenant Invoice Settings**: Per-tenant configuration — VAT rate, registration fee, legal identity, numbering format, reset cadence, pro-rate policy, logo. Changes are audited. Snapshotted on every invoice.
- **Audit Event**: Append-only entry for every financially significant action (see FR-015).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can issue a first Thai-tax-compliant invoice for an existing member in under **2 minutes** from opening the member page, without needing admin support or re-reading documentation.
- **SC-002**: **100% of generated PDFs** satisfy a Thai-RD invoice/receipt checklist (label, tenant legal identity, customer identity, itemised lines, subtotal + VAT + total, sequential number, issue date). Verified by a reviewer with Thai accounting context before F4 ships.
- **SC-003**: **Downloading the same issued invoice PDF returns byte-identical content 100% of the time** for the lifetime of the document. Mechanism is Source-of-truth: PDFs are persisted to content-addressable Blob storage at issue time and streamed verbatim on every subsequent download — never re-rendered. Render pipeline determinism is pinned (Math.random + Date stubbed) as defense-in-depth. Auto-rerender on Blob outage (R3-E4) is an operationally rare resilience path that MUST emit `invoice_pdf_regenerated` audit. Bytes from a regenerated PDF MAY differ from the original **only in the compressed font-subset stream** (documented technical limit of `@react-pdf/renderer` v4 font-subsetting — upstream issue tracked in `retrospective.md`); **every other dimension of the document MUST be verifiably identical**: sequential document number, issue date, due date, tenant + member identity snapshots (legal name, tax IDs, addresses), line-item descriptions + quantities + prices, VAT rate + VAT amount, subtotal + total, Thai baht amount-in-words, and any credit-note linkage fields. Verification mechanism MUST extract and compare the PDF text layer + structured fields (not binary sha256) on the regenerated path.
- **SC-004**: Tenant-isolation test suite — a member of tenant A attempting to access any invoice of tenant B via UI, API, or direct route — fails **0** times across the full matrix (Constitution Principle I Review-Gate blocker).
- **SC-005**: An invoice list of **5,000 invoices** within a tenant loads the first page in under **500 ms** at the p95 (matching the F3 member-directory bar).
- **SC-006**: **100% of financially significant actions** (create, issue, pay, void, settings change, cross-tenant probe) produce an audit entry that a manager can later review.
- **SC-007**: A member signs in and downloads their own invoice PDF in under **1 minute** from landing on the portal, with **0** support tickets needed in the first month of live use.
- **SC-008**: In the **first month** after F4 goes live, the SweCham admin reports **zero** PDF-resend support workload in the monthly retrospective check-in (binary outcome — measured by a single retro question; baseline-capture not required).
- **SC-009**: Phase 1 "replace Excel" goal is met — at least **90% of new invoices** in the first full month after F4 ship are issued through the system, not in Excel.
- **SC-010**: An admin can reconstruct any member's complete billing history (all invoices + all credit notes + all events) in under **30 seconds** from the member detail page, without opening any other screen.
- **SC-011**: **100%** of F4 state-change events appear in the F3 member timeline within **5 seconds** of the triggering action.

## Assumptions

- **Manual payment only**: online payment (Stripe / PromptPay) is explicitly F5, not F4. F4 supports recording a manually reconciled payment. F5 will layer online payment on top of F4's invoice state machine via webhooks.
- **Membership invoices only**: F4 covers the "MB" (membership) document type. Event-fee invoices, sponsorship invoices, and ad-hoc invoices are not part of this feature — they're a separate feature on their own.
- **Thai + English PDFs are the legal documents**: Swedish (SV) invoice PDFs are not required for Thai-RD compliance. SV is supported for UI labels only. If a Swedish member requests an SV invoice, the EN translation alongside the TH is acceptable.
- **Calendar fiscal year by default**: membership cycles and tax-number resets follow the Gregorian calendar year (Jan 1 – Dec 31). Tenants MAY configure a custom cycle start month.
- **One currency per tenant**: THB for the SweCham tenant. Multi-currency invoices are deferred.
- **No partial payments**: an invoice is either unpaid, fully paid, voided (if unpaid), or credited (if paid, via credit note).
- **Credit notes are in scope**: paid invoices are corrected via formal ใบลดหนี้ / Credit Note (US6 + FR-020 … FR-023), not by voiding or editing.
- **Pro-rate supports monthly and daily**: tenants configure `none` / `monthly` / `daily`; the choice is snapshotted per invoice.
- **Registration fee once per member lifecycle by default**: the registration-fee line is added when the member's status indicates "new this cycle" (to be refined in planning based on F3 member state). A tenant can disable the registration fee entirely by setting amount = 0.
- **Deterministic PDF generation**: any template change is a versioned migration that only affects newly issued documents; past documents continue to render with their original template version.
- **Depends on F1 (Auth & RBAC)** shipped via PR #1, **F2 (Membership Plans)** review-ready on `002-membership-plans`, and **F3 (Members & Contacts)** review-ready on `005-members-contacts`. F4 assumes all three are on `main` before F4 ships.
- **Tax-RD reviewer**: a maintainer (or contracted Thai accountant) will sign off on the bilingual invoice/receipt/credit-note PDF templates and numbering scheme before ship, per Constitution Principle VIII (finance sensitivity).

## Out of Scope

The following are explicitly **not** part of F4 and will be tackled in later features:

- Online payment capture (Stripe, PromptPay) — **F5**.
- Renewal reminders, auto-renewal, at-risk detection — **F8**.
- Partial / instalment payments (multi-payment against a single invoice).
- Event registration invoices, sponsorship invoices, and ad-hoc invoices.
- Multi-currency invoices (SEK, EUR, USD as transactable currencies).
- Direct e-tax filing with Thai Revenue Department (RD e-tax submission API) — deferred per R1 decision in `docs/phases-plan.md` (Stripe chosen over Omise on that basis).
- Bulk invoice issuance (generate invoices for all members at once for a new cycle). A one-off admin script may cover day-1 operational need but is operational tooling, not part of the spec.
