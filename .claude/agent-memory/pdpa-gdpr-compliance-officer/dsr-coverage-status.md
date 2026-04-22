---
name: Data Subject Rights (DSR) Coverage Status by Feature
description: Tracks which DSR rights (GDPR Art. 15-21 / PDPA §30) are implemented vs. deferred to F9 across all shipped features
type: project
---

**Overall DSR strategy:** F9 is the dedicated DSR/export/erasure feature. All F-stream features implement partial access (own-data portal views) but full export/erasure is deferred.

**F1 Auth:**
- Access: session list (partial — portal not yet implemented)
- Erasure: account deletion not yet implemented
- Portability: deferred F9

**F2 Plans / F3 Members:**
- Access: member portal view of own profile (F3 US5 — implemented)
- Rectification: member self-update (F3 US5 — implemented)
- Erasure: member archive implemented (F3 US7); hard-delete/GDPR-erasure = post-MVP
- Portability: deferred F9

**F4 Invoicing:**
- Access: `/portal/invoices` — member views own invoice list (implemented, T069 tested)
- Access (full): deferred F9 per FR-031
- Rectification: N/A — tax document snapshots intentionally immutable post-issue (legal record)
- Erasure: REFUSED under GDPR Art. 17(3)(b) / Thai Revenue Code §87/3 legal-obligation carve-out (FR-030). F9 must implement the carve-out explicitly.
- Portability: deferred F9 per FR-031
- Objection: N/A — processing basis is legal obligation (not legitimate interest)

**F9 prerequisites identified in F4 review:**
1. Audit event `retention_basis` marker to distinguish legal-obligation rows from erasable rows (M-2 from F4 review 2026-04-22)
2. `email_delivery_events.to_email` retention policy must be defined before F9 DSR implementation (M-1)
3. Raw `recipient_email` in audit payloads must be pseudonymised (H-1) before F9 erasure scope is determined

**How to apply:** At F9 design stage, verify these three prerequisites are resolved. The F9 erasure workflow must NOT wipe `audit_log` rows where `retention_basis = 'legal_obligation'`.
