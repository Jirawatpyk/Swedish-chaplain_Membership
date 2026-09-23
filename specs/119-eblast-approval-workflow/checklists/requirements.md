# Specification Quality Checklist: E-Blast Two-Sided Approval Workflow, Writing Tool Upgrade & Marketing Dashboard

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-09-17
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

- Validation iteration 1 (2026-09-17): 15/16 — FR-031 carried the single [NEEDS CLARIFICATION]
  marker (what "e-blast/newsletter" covers).
- Validation iteration 2 (2026-09-17): 16/16 with the full scope (option C: chamber newsletter
  authored and sent from the platform).
- Validation iteration 3 (2026-09-17): 16/16 after the scope was split. **119 = the member E-Blast
  only** (5 user stories, FR-001..FR-037, SC-001..SC-009). The chamber newsletter moved to the
  parked notes in `specs/120-chamber-newsletter/README.md` and opens as its own feature only if
  SweCham confirms they want it. Reason: 119 is a strict subset of the full scope, is needed
  whatever SweCham answers, and the newsletter does not change its design — so it proceeds without
  waiting for the answer.
- Validation iteration 4 (2026-09-18): 16/16 after the maintainer widened the scope on the strength of
  a code-level exploration + UX audit: **US3 "Marketing has a real writing tool" (P1)** — FR-037..046
  (toolbar parity with what survives sending, staff drafts + images, mandatory alt text, three
  system-controlled design blocks: CTA button / full-width banner / chamber logo header, a real
  preview inline + dialog with desktop/phone widths, no italic for Thai, template choice never
  destroys typed text) — and **US6 "Every E-Blast screen meets the platform's standard" (P2)** —
  FR-047..051 (error/loading/empty states, announced validation, toolbar keyboard pattern, member
  detail shows content, compose width, UX checklist + WCAG scan gate). SC-010..013 added. The tool
  upgrade and screen fixes are deliberately NOT behind the feature flag (§ cross-cutting).
  Rationale recorded in § Clarifications (session 2026-09-18): with today's tool marketing can do
  nothing a member cannot, so the approval round would be ceremony. Stories renumbered: dashboard =
  US4, notifications = US5, trial = US7.
- FR-036 — the dashboard shows recipient counts only and defers to the existing Marketing audience
  page (feature 108) for who the recipients are.
- FR-037 — staff can send themselves a test copy of a formatted version (kept from the full-scope
  draft, restricted to E-Blasts).
- The flag name and role names in § Chamber-OS cross-cutting requirements are required by the
  project's spec template and are not counted as implementation leakage.
- SC-009 is qualitative by design (the request is "test it and give feedback"); it is verified by
  the UAT debrief, not by an automated test.
- A scope-confirmation document (EN + TH) has gone to SweCham. Answers that would change 119, all
  small or additive, none blocking: (2) member sign-off mandatory for every E-Blast vs only when
  marketing changed the content — default: only when changed; (3) who on the member side may
  approve — default: any portal user of that company; (4) reminders at 3 and 7 days, never an
  automatic approval — default: yes; (7) open/click rates on the dashboard — default: not included.
  Carry these as the first candidates into `/speckit.clarify`.
