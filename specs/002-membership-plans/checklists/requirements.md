# Specification Quality Checklist: F2 — Membership Plans

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-04-11
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Items marked incomplete require spec updates before `/speckit.clarify` or `/speckit.plan`
- **Validation pass 3 outcome (2026-04-11, post round-2 critique)**: all 16 items still pass after applying round 2's 2 Must-Address (R1 currency immutability, R2 plan.md filename + 10-event count consistency) and 3 Recommendations (P7 MemberAttachmentChecker port, P8 SC-008 split + preconnect, P9 audit payload diff shape + zod schema location). Round 2 critique report: `critiques/critique-2026-04-11T095811Z.md`. No new findings — the two Must-Address items were regression-class bugs introduced by round-1 remediation (R1 = over-broad currency-change semantics I wrote into the contract; R2 = incomplete filename propagation into plan.md).
- **Validation pass 2 outcome (2026-04-11, post round-1 critique)**: all 16 items still pass after applying all 4 Must-Address (X1c, E1/X2, E3, E5) and 11 Recommendations from `critiques/critique-2026-04-11T091021Z.md`. US7 (Inline Edit + Bulk Actions) deferred to F3; US6 (Command Palette) retained. Per-plan currency dropped (P3 YAGNI). Tenants cross-cutting module introduced. Audit schema extension aligned with verified F1 pgEnum (E10). All event-type identifiers normalised to snake_case (`plan_created` not `plan.created`).
- **Validation pass 1 outcome (2026-04-11)**: all 16 checklist items pass.
  - Zero `[NEEDS CLARIFICATION]` markers were written into spec.md — the open questions Q1–Q5 are explicitly routed to `/speckit.clarify` via the Assumptions section rather than littering FRs with inline markers, because they primarily affect F3/F4 behaviour and F2 can proceed with reasonable defaults documented in the edit-form warning copy.
  - Acceptance scenarios are Given/When/Then, each attached to a prioritised independent user story.
  - Success criteria are user-outcome or probe-test phrased with concrete thresholds (2 s, 30 s, 100 ms, 3 minutes) — no implementation language leaks.
  - Spec references `Constitution v1.4.0 Principle I` by clause number (3, 4) and `docs/membership-benefits-analysis.md` by section (§2, §3, §4, §5) so downstream gates can verify claims against the source.
- **Open items for `/speckit.clarify`** (not checklist failures, but governance items):
  - Q1 Start-up 2-year clock origin (member start date vs company incorporation)
  - Q2 Thai Alumni age-based model (single `members` table with `member_type` enum vs separate individual table)
  - Q3 Pro-rate on mid-year join (default: pro-rate by remaining months — needs confirmation)
  - Q4 Upgrade / downgrade mid-term accounting (default: pay pro-rated difference — needs confirmation)
  - Q5 Registration fee trigger (default: first-ever enrolment only — needs confirmation)
  - Plus: does F2 introduce the tenant-context resolver as cross-cutting infrastructure, or does `/speckit.plan` defer it to a future F10 SaaS-onboarding phase? Recommendation: introduce it now to satisfy Constitution v1.4.0 Principle I defence-in-depth — it's a prerequisite for `tenant_id` scoping whether we ship 1 tenant or 10.
