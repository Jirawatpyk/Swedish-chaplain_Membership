# Specification Quality Checklist: Member Portal — Approval Workflow for Member Changes

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-11
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — the three raised at specify (field-set widening · which changes are gated · whole-request vs per-field decision) were answered by the maintainer on 2026-09-11 and are encoded in § Clarifications, § Overview (Group A/B/C), FR-002–FR-004 and FR-014–FR-016
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded (§ Out of Scope + § Assumptions)
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (submit → notify → per-field approve/reject → sync → history; withdraw/replace; tenant switch)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`
- Validation iteration 1 (2026-09-11): all content/readiness items passed; the single failing item was the three deliberate [NEEDS CLARIFICATION] markers.
- Validation iteration 2 (2026-09-11, after maintainer discussion): all items pass. Decisions encoded — Group A immediate / Group B gated / Group C staff-only; Group B widened by job title, company name, registered address, billing address (with its country line); phone gated; tax block, member country, founded year, turnover and capital staff-only; per-field decision with all fields pre-approved, one reason for the rejected set, mixed outcome = *partially approved*, address groups decided as one row.
- Validation iteration 3 (2026-09-11, after `/speckit-clarify` + `spec-review-panel`): all items pass. Clarify added reviewer right = `members.write`, primary-only company fields with one pending request per submitting person, and the 10-per-24 h cap + 1 h email coalescing. The panel (GO WITH AMENDMENTS, `reviews/spec-review-panel-20260911.md`) closed one confirmed premise defect (FR-013 self-review clause deleted) plus five hygiene lines and eight maintainer-verified items (founded year → Group C; two preferred-language settings named; immediate-write path closed under the gate; portal history scoped per person; registered address tax flag; at-least-once wording + durable cap; "nothing to submit" baseline; `members.read` for viewing). ~110 unverified panel inputs are carried to `/speckit-plan` as questions.
- Premises checked against the code before writing: the current self-service edit applies immediately (`member-self-update` use case, `/portal/edit`); the editable set is the F3 compile-time tuple; the widened fields all exist on the Member / Contact domain types; the email-address change, colleague invite, marketing opt-out and renewal-reminder preference are separate flows; F7 already has a staff approve/reject-with-reason queue for E-Blasts (UX precedent); the after-commit email outbox and the member timeline exist; tax documents freeze the buyer block at issue (088), so an approved company-name/billing-address change cannot rewrite issued documents.
