# Privacy (PDPA + GDPR) Requirements Quality Checklist: 016 RBAC Permissions

**Purpose**: Validate that data-protection requirements are complete and precise — marketing's member-data read scope, erasure-permission moves, audit payload minimisation, and documentation duties. Gate-4 artefact for the `pdpa-gdpr-compliance-officer` review pass.
**Created**: 2026-08-10
**Feature**: [spec.md](../spec.md) · design §4.1/§12 · plan Constitution Check §I

## Lawful Basis & Documentation

- [ ] CHK033 - Is the new processing activity (staff role administration) named with an update duty on the ROPA/privacy docs, and is the delivery point pinned (PR 4)? [Completeness, Spec §FR-018, Design §12]
- [ ] CHK034 - Is marketing's member-data READ access documented as a processing-scope change (purpose + minimisation rationale), not just as a permission mapping? [Completeness, Spec §FR-018, Design §12]
- [ ] CHK035 - Is the DPIA-trigger question answered in the requirements (does adding a marketing read-role over member PII require a DPIA under the project's PDPA+GDPR standard, or is the existing assessment sufficient)? [Gap, plan Constitution §I]

## Data Minimisation — marketing scope

- [ ] CHK036 - Is the sensitive-PII field CLASS defined by enumerable criteria (which fields move behind `members.pii_sensitive` — DoB named; is the full list closed or discoverable)? [Clarity, Spec §FR-013, Design D11]
- [ ] CHK037 - Are marketing's denied egress channels enumerated exhaustively (directory export, unredacted activity feed, finance insights, sensitive-PII fields in BOTH UI and API responses)? [Completeness, Spec §US3-AS2/AS4, §SC-004]
- [ ] CHK038 - Is server-side enforcement (data absent from payload) distinguished from presentation hiding for the marketing dashboard/profile requirements? [Clarity, Spec §US3-AS4, contracts/authorization-surfaces §6]
- [ ] CHK039 - Do the requirements state that marketing's broadcast recipient access does NOT expose member PII beyond what the broadcast module already discloses to its operators (no new PII surface via F7)? [Gap, Coverage]

## Data-Subject Rights & Erasure

- [ ] CHK040 - Are both erasure endpoints (member erasure F3, attendee erasure F6) explicitly tied to their `superAdminOnly` keys, and is the erasure LOG read also SA-only? [Completeness, Spec §FR-013, Design D10]
- [ ] CHK041 - Is the interplay between the last-super-admin ERASE refusal and data-subject erasure rights documented (the refused account is a staff operator, not a data subject exercising Art. 17 — is that rationale recorded so the refusal is defensible)? [Gap, Spec §FR-009, Design D13]
- [ ] CHK042 - Do the requirements preserve the ability to fulfil access/erasure requests "without code changes" (Constitution §I) after permission concentration to SA — i.e., is the SA-availability assumption for compliance operations stated? [Assumption, Design §12 SoD residual]

## Audit & Log Hygiene

- [ ] CHK043 - Is the `permission_denied` payload pinned as a CLOSED list (`actor_user_id, role, permission_key, route_path without query, request_id` — "and nothing else"), keeping tokens/emails/query PII out by construction? [Clarity, Spec §FR-006, Design §6.1]
- [ ] CHK044 - Is the retention class for `permission_denied` stated (5y default) and consistent with the audit-retention policy table? [Completeness, Spec §Key Entities, Design §5]
- [ ] CHK045 - Are the audit-viewer redaction requirements consistent with PII minimisation for NON-`audit.read` viewers on the ON leg (redacted projection), with the unredacted projection reserved to SA? [Consistency, Spec §FR-011, Design §4.3]
- [ ] CHK046 - Do denial-metric requirements (`rbac.permission_denied_total{role, permission}`) avoid high-cardinality PII labels (no actor id in metric labels; per-actor aggregation only in logs/queries)? [Gap, Spec §FR-016, Design §11]

## Cross-Border & Residual Risks

- [ ] CHK047 - Is it stated that no NEW data category or third-party transfer is introduced (no new processor, no new region), so the existing SCC/PDPA §28 posture is unchanged? [Completeness, plan Constitution §I]
- [ ] CHK048 - Is the Phase-1 SoD concentration residual (SA holds all compliance surfaces) recorded as an ACCEPTED risk with its Phase-2 relief valve, rather than left implicit? [Assumption, Design §12]

## Notes

- Any unresolved [Gap] on CHK035/CHK041 must be answered in spec §Assumptions or design §12 before `/speckit.tasks`.
