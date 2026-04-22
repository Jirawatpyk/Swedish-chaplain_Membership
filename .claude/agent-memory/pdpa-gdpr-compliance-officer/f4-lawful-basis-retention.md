---
name: F4 Lawful Basis & Retention Policy
description: F4 tax-document processing uses legal-obligation basis (§87/3 + GDPR Art. 6(1)(c)), distinct from F1-F3 contractual-necessity; 10-year retention floor
type: project
---

F4 (Invoicing & Thai-Tax Receipts) is the first Chamber-OS feature where the legal-obligation lawful basis applies, overriding GDPR right-to-erasure (Art. 17(3)(b)).

**Lawful basis mapping (F-stream):**
- F1 Auth: contract (GDPR Art. 6(1)(b) / PDPA §19)
- F2 Plans: contract
- F3 Members: contract
- F4 Tax documents (invoices, receipts, credit notes, identity snapshots): **legal obligation** — Thai Revenue Code §87/3 + GDPR Art. 6(1)(c). Retention ≥ 10 years from issue date.
- F4 Audit log (F4 events): legal obligation, ≥ 10 years (extended from F1-F3's 5-year baseline)
- F4 Auto-email PDF delivery: contract/service delivery (PDPA §19 + GDPR Art. 6(1)(b)) — transactional, NOT marketing, PDPA §24 separate-consent requirement does not apply

**Why:** Tax documents are immune to member archive/erasure (FR-030). GDPR erasure requests for tax docs must be refused under Art. 17(3)(b). F9 will implement the erasure workflow with this carve-out.

**How to apply:** When reviewing F5+ features that touch invoices or tax documents, confirm the legal-obligation basis is cited explicitly, not contractual-necessity. When F9 DSR/erasure endpoint is designed, verify the carve-out is implemented and tested.
