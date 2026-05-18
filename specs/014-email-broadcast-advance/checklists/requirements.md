# Specification Quality Checklist: F7.1a — Email Broadcast Advanced (Pagination + Image Embedding + Multi-Template)

**Purpose**: Validate specification completeness and quality before proceeding to planning + tasks
**Created**: 2026-05-17 (Strategy B split + US7 promote-back on 2026-05-18)
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs) in spec.md
- [X] Focused on user value and business needs
- [X] Written for non-technical stakeholders
- [X] All mandatory sections completed (User Scenarios, Requirements, Success Criteria)

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain — all 4 F7.1a-applicable clarifications resolved in Session 2026-05-17 (Q1 batch boundary; Q2 virus scanner; Q3 partially_sent state semantics; Q4 image upload size cap). 6 deferred clarifications preserved in `f71b-backlog.md` for US3-US8 promotion.
- [X] Requirements are testable and unambiguous (FR-001..008 + FR-008a/b/c/d sub-items + FR-009..023 = **27 FRs total**, each MUST-clause maps to one or more SC-NNN)
- [X] Success criteria are measurable (SC-001 … SC-010 each carry a number, percent, or zero-defect assertion)
- [X] Success criteria are technology-agnostic (no framework, library, or table names; only outcomes and behaviours)
- [X] All acceptance scenarios are defined (4–7 per user story, Given/When/Then format)
- [X] Edge cases are identified (10 enumerated edge cases covering cross-feature, partial-failure, retry race, and template-conflict classes)
- [X] Scope is clearly bounded (Context section + Out-of-Scope list explicitly enumerates deferrals to F7.1b + beyond)
- [X] Dependencies and assumptions identified (Assumptions section + Dependencies-on-existing-systems section)

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria (each US has both FR-NNN and Acceptance Scenarios; SC-NNN ties back to FR-NNN)
- [X] User scenarios cover primary flows (**3 user stories**: 2 P1 + 1 P2 prioritised by chamber-value impact)
- [X] Feature meets measurable outcomes defined in Success Criteria (**13 SC items**: SC-001..010 + SC-007a + SC-007b + SC-007c covering all 3 user stories + 3 cross-cutting items)
- [X] No implementation details leak into specification (Key Entities described as concepts; storage / scanner / batching primitive choices documented in `plan.md` per Constitution III)

## Notes

- **Strategy B scope split (2026-05-18)**: Original F7.1 8-US bundle was split into F7.1a (this spec) + F7.1b ([`f71b-backlog.md`](../f71b-backlog.md)) per critique recommendation. F7.1a ships 2 P1 USs (US1 pagination + US2 image embedding) immediately; F7.1b waits for 4-6 weeks of F7 MVP + F7.1a production data before promoting US3-US8.
- **US7 promote-back (2026-05-18)**: Multi-template library was originally deferred with F7.1b, but promoted back to F7.1a after maintainer committed to writing starter template content directly (`starter-templates.md` — 5 templates × 3 locales). No compliance-liaison-blocker; admins refine post-ship via FR-016 template-CRUD UI.
- **Audit findings remediated (2026-05-18)**: 2 CRITICAL (C1 migration numbering 0124→0127, C2 ClamAV deployment Vercel-sidecar→Fly.io VM) + 6 HIGH (H1 entity count, H2 audit event count, H3 i18n key estimate, H4 dev/prod parity, H5 SC-018 fixture test, H6 US3 contract file) all closed pre-critique.
- **Critique findings status (2026-05-18)**:
  - 3 🎯 Must-Address: 2 resolved by Strategy B (P1 production-data gap → F7.1a smaller scope; X1 US5 deferred → moved to F7.1b); 1 closed by US3 deferral (E13 F3 backfill scale ceiling — US3 deferred so the backfill is too)
  - 21 💡 Recommendations: most apply to deferred USs and preserved in `f71b-backlog.md`; F7.1a-applicable ones (E1 ClamAV endpoint resolver, E4 retry advisory lock, E6 attachment filename XSS deferred with US4, E11 7500-recipient non-gated CI smoke, E14 flag-matrix test plan, E15 schema rollback strategy, P10 ClamAV-down UX, P11 cancel mid-dispatch UX, P12+X5 kill-switch criteria, X2 starter library) are integrated into plan.md § Rollback Strategy + spec.md edge cases + Acceptance Scenarios.
  - 7 🤔 Questions: mostly belong to deferred USs; P3 (F11 SaaS timeline confirm) + E16 (Fly.io vendor maturity) remain open for operator/maintainer ship-day review.
- Total (F7.1a after Strategy B + US7 promote-back + critique round 2 fixes + clarify round 3 + audit cleanup, 2026-05-18): **3 user stories / 27 functional requirements (23 base FRs + 4 sub-items under FR-008) / 13 success criteria (SC-001..010 + SC-007a + SC-007b + SC-007c) / 5 key entities (3 NEW + 2 EXTEND) / 10 edge cases / 10 new audit event types / 8 migrations (0127-0134) / 12 use-cases / 4 feature flags / 3 active contract files + 5 deferred under deferred-f71b/ / many out-of-scope items in F7.1b backlog / 4 open considerations (3 resolved in clarify r3 + 1 deferred-decided: P7 auto-gen) / 14 clarifications resolved (10 from sessions 1+2 + 4 round 3)**.
- **Critique round 2 remediation (2026-05-18)**: 2 🎯 must-address closed (E1+X1+P5+E6 = variable substitution semantics via `{{chamber_name}}`-only + `[bracketed]`-everything-else; E2+X2 = `scripts/generate-template-seed-migration.ts` auto-gen + CI gate). 12/12 💡 recommendations applied across spec/plan/data-model/contracts/quickstart. 4 🤔 questions surfaced in `plan.md § Open Considerations` for operator/maintainer review at ship-day.
- All `/speckit.clarify` + `/speckit.critique` rounds complete (clarify × 2 + critique × 2 + i18n-translation-reviewer × 1). Spec is ready for `/speckit.tasks`.
