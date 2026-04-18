# Compliance Requirements Quality Checklist: F4 — Membership Invoicing & Thai-Tax Receipts

**Purpose**: Validate the **quality of compliance-related requirements** in spec + plan — Thai Revenue Department (§86/4, §87, §87/3), PDPA (Thailand), GDPR (Sweden/EU), and Chamber-OS Constitution v1.4.0 Principle I tenant-isolation clauses. "Unit tests for English" — we're testing whether requirements are complete, clear, consistent, measurable, and well-bounded, NOT whether the implementation works.
**Created**: 2026-04-18
**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Depth**: Standard (PR review gate, pre-`/speckit.tasks`)

## Thai RD Tax-Document Requirements

- [ ] CHK001 Are the required fields on a Thai tax invoice (ใบกำกับภาษี) enumerated completely per §86/4 — tenant legal name + tax ID + address, customer legal name + tax ID + address, itemised line description/unit/qty/price, VAT subtotal/total, sequential number, issue date, document label? [Completeness, Spec §FR-004]
- [ ] CHK002 Is the sequential-numbering no-gap guarantee (Thai RD §87) quantified as a structural property, not a detection rule? [Clarity, Spec §FR-003]
- [ ] CHK003 Are the required fields on a Thai official receipt (ใบเสร็จรับเงิน) specified separately from the tax-invoice fields, including payment date + method + reference? [Completeness, Spec §FR-006, §FR-004]
- [ ] CHK004 Are the required fields on a Thai credit note (ใบลดหนี้) specified, including reference to the original document number, credit amount, VAT recalculation, and reason? [Completeness, Spec §FR-020]
- [ ] CHK005 Is the "combined vs separate" invoice/receipt filing mode documented with explicit behaviour for each (single document superseding invoice on payment, vs two independent documents)? [Clarity, Spec Clarifications Session 2]
- [ ] CHK006 Is the Thai amount-in-words requirement explicitly stated as a mandatory element, and is its generation specified to an unambiguous precision (satang vs. baht-only)? [Completeness, Plan research §6]
- [ ] CHK007 Are Thai Buddhist Era (BE) display requirements specified consistently — storage as CE, display as BE for `th-TH`, and both CE+BE on PDFs? [Consistency, Spec §FR-017, US1 AS3]
- [ ] CHK008 Is the VAT calculation method (total-level rounding per Thai RD convention) explicitly documented and distinguished from line-level rounding? [Clarity, Plan research §6]
- [ ] CHK009 Are the preconditions for issuing a credit note (paid invoice only, amount ≤ remaining balance) specified with no ambiguity about partial-credit accumulation? [Clarity, Spec §FR-020, §FR-022]
- [x] CHK010 Is the VOID-stamp requirement specified including bilingual text, placement rule, and whether the VOID-stamped PDF replaces or coexists with the original PDF? [Completeness, Spec §FR-008, §FR-036] — **RESOLVED**: FR-008 expanded — diagonal ~45° overlay, 40-60% opacity, every page, "VOID / ยกเลิก" bilingual, replaces Blob at same content-addressed key

## Retention & Data Lifecycle

- [ ] CHK011 Is the tax-document retention period quantified with an exact duration and starting event (10 years from issue date)? [Clarity, Spec §FR-029]
- [ ] CHK012 Are the retention rules for invoice, receipt, and credit note documented as one policy, or are differences between document types specified where they exist? [Consistency, Spec §FR-029]
- [ ] CHK013 Is the interaction between tax-document retention and member archive/deletion unambiguous — tax docs survive, member profile may be archived? [Clarity, Spec §FR-030]
- [ ] CHK014 Is the legal basis for retention documented (Thai RD §87/3 + GDPR Art. 6(1)(c) legal obligation) with specific citations rather than generic "compliance"? [Traceability, Spec §FR-029, §FR-030]
- [ ] CHK015 Are the handoff requirements for F9 GDPR/PDPA export + erasure — specifically how tax documents are surfaced as a distinct retention category — specified? [Completeness, Spec §FR-031]
- [ ] CHK016 Is the retention requirement for F4 audit events quantified (≥ 10 years) consistently with the tax-document retention, not silently inheriting F1-F3's 5-year baseline? [Consistency, Plan §VIII Reliability]

## Tenant Isolation (Constitution v1.4.0 Principle I)

- [ ] CHK017 Are all five Principle I clauses (app-layer, db-layer, integration test, audit, super-admin) mapped to concrete F4 deliverables, not left as generic acknowledgements? [Completeness, Plan Constitution Check I]
- [ ] CHK018 Is the list of cross-tenant-probe audit events exhaustive across all F4 tables (invoices, invoice_lines, credit_notes, tenant_invoice_settings, tenant_document_sequences)? [Completeness, Spec §FR-015, Plan Constitution Check]
- [ ] CHK019 Are the cross-tenant alert thresholds quantified (1/5min alarm, 5/hour incident) and tied to specific event types, not left as "monitor it"? [Measurability, Plan Constitution Check I clause 4]
- [ ] CHK020 Is the 404-vs-403 response choice for cross-tenant probes explicitly stated (to avoid resource-existence disclosure)? [Clarity, Spec §FR-013]
- [ ] CHK021 Is the super-admin impersonation behaviour specified for F4 (out-of-scope for F4 but documented as F13 obligation for future)? [Completeness, Plan Constitution Check I clause 5]

## PDPA + GDPR Cross-Border

- [ ] CHK022 Are the PII fields captured on tax-document snapshots enumerated (member legal name, tax_id, address) and aligned with F3's consent basis documentation? [Consistency, Spec §Assumptions, Plan Constitution Check I]
- [ ] CHK023 Is the Singapore-hosting escape clause (Constitution § Compliance) re-acknowledged in the F4 plan with PDPA §28 + GDPR SCCs citation? [Traceability, Plan Complexity Tracking]
- [ ] CHK024 Are cross-border transfer implications of auto-emailing PII through Resend documented with explicit DPA coverage, not left as implicit trust? [Completeness, Research §8a]
- [ ] CHK025 Is the interaction between GDPR right-to-erasure and tax-document legal obligation (FR-030) explicit enough that a compliance reviewer can distinguish which data honours erasure vs. which is retained? [Clarity, Spec §FR-030, §FR-031]

## Audit Trail (Principle VIII — Finance sensitivity)

- [ ] CHK026 Are all 16 F4 audit event types listed with their triggering action, actor, and required payload fields — no placeholders, no "etc."? [Completeness, Spec §FR-015, Data-model §4]
- [ ] CHK027 Is the append-only + non-mutable + non-deletable property of audit events stated as a hard requirement rather than a convention? [Clarity, Spec §FR-015]
- [ ] CHK028 Are the audit payload conventions for financially significant events (issued, paid, voided, credit_note_issued) enumerated to the field level? [Completeness, Data-model §4]
- [ ] CHK029 Is the idempotency of `invoice_overdue_detected` emission specified (partial unique index once-per-invoice-per-Bangkok-day) to prevent audit-log pollution? [Measurability, Data-model §4]

## Traceability + Measurability

- [ ] CHK030 Is a Thai-RD-reviewer sign-off gate specified with actionable exit criteria, not as a soft "reviewer should approve"? [Measurability, Spec §Assumptions, Plan §IX Code Quality]

---

**Traceability summary**: 30/30 items reference spec sections, plan sections, data-model, research, or explicit quality markers. Coverage ≥ 80% achieved (100%).
