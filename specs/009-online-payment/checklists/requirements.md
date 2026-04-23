# Specification Quality Checklist: F5 — Online Payment (Stripe + PromptPay)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-04-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [X] No implementation details (languages, frameworks, APIs)
      *(Stripe + PromptPay appear because they are business-level decisions pre-locked by Constitution § Payment + phases-plan R2, not tech-stack choices made in this spec. No code structure, migration SQL, or library APIs leak in.)*
- [X] Focused on user value and business needs
      *(Every user story frames the value to admins / members / treasurer; WHY blocks are explicit.)*
- [X] Written for non-technical stakeholders
      *(A Thai chamber treasurer can read the US narratives, SCs, and Assumptions without a developer.)*
- [X] All mandatory sections completed
      *(Context, Clarifications, User Scenarios & Testing, Requirements, Success Criteria, Assumptions present.)*

## Requirement Completeness

- [X] No [NEEDS CLARIFICATION] markers remain
      *(All resolved across 2 sessions on 2026-04-23. **Session 1 (`/speckit.specify`)**: Q1 = ship card + PromptPay together as P1 MVP; Q2 = in-app refund only with out-of-band detection + reject; Q3 = portal-authenticated only in MVP with `allow_anonymous_paylink` forward-compat column for F5.1. **Session 2 (`/speckit.clarify`)**: Q4 = embedded Sheet drawer on invoice detail page (no new `/pay` route, no Checkout redirect); Q5 = pin Stripe API version via `STRIPE_API_VERSION` env var; Q6 = free-form THB refund amount + multiple partial refunds per payment. New FRs added: FR-011a, FR-011b, FR-016a, FR-025, FR-026; 2 new audit events (`webhook_api_version_mismatch`, `out_of_band_refund_detected`); 2 new metrics (`out_of_band_refund_rejected_total`, `member_invite_to_payment_funnel_dropoff`); US4 gained AS5+AS6 for partial-refund scenarios.)*
- [X] Requirements are testable and unambiguous
      *(Each FR has an observable outcome; tenant isolation, PCI boundary, and audit-trail obligations are stated as MUSTs with explicit event names and states.)*
- [X] Success criteria are measurable
      *(All 13 SCs have numeric thresholds or binary-verifiable conditions; no "fast" / "robust" without numbers.)*
- [X] Success criteria are technology-agnostic (no implementation details)
      *(SCs describe WHAT is measured at the user/system boundary — p95 latency, audit completeness, variance, zero-PAN — not WHICH library / endpoint.)*
- [X] All acceptance scenarios are defined
      *(6 user stories × 3–5 AS each; every user-visible state transition and every failure mode enumerated in § Edge Cases.)*
- [X] Edge cases are identified
      *(15 edge cases spanning webhook replay, race conditions, outages, currency, session expiry, GDPR-deletion, sandbox/live mismatch, sensitive-data leakage, a11y, i18n.)*
- [X] Scope is clearly bounded
      *(§ Context explicitly lists F5 vs. F8 vs. F11 boundary; § Assumptions lists OUT-OF-SCOPE: partial payment, multi-currency, renewal flow, Google/Apple Pay, dispute workflow, admin UI for settings.)*
- [X] Dependencies and assumptions identified
      *(§ Dependencies lists F1/F4/F8/F11 relationships; § Assumptions covers Scope / Security / UX / Operational.)*

## Feature Readiness

- [X] All functional requirements have clear acceptance criteria
      *(Every FR is traceable to a US acceptance scenario or an SC; FR-011 explicitly marked as pending Q2.)*
- [X] User scenarios cover primary flows
      *(US1 card happy path, US2 PromptPay happy path, US3 admin reconciliation, US4 refund, US5 failure longtail, US6 receipt email.)*
- [X] Feature meets measurable outcomes defined in Success Criteria
      *(Each SC has an implicit test strategy — adoption / efficiency / perf / reliability / PCI / audit / webhook / isolation / variance / a11y / kill-switch.)*
- [X] No implementation details leak into specification
      *(Processor choice + PromptPay are scope-level; "Stripe Elements" is named because Constitution Principle IV explicitly prescribes hosted-field capture and SAQ-A scope, making it a compliance fact, not a tech choice.)*

## Notes

- All quality gates pass — spec is ready for `/speckit.plan`.
- Six answered clarifications across two sessions (Q1–Q3 from `/speckit.specify`, Q4–Q6 from `/speckit.clarify`) are recorded in § Clarifications and operationalised by FR-011 (updated), FR-011a, FR-011b, FR-016a, FR-025, FR-026, plus 2 new audit events and 2 new metrics in FR-020/FR-021. US4 expanded with AS5+AS6 for partial-refund coverage.
- Review gate will require **≥2 reviewers** (PCI surface per Constitution IX) with one signing the security checklist. The solo-maintainer 5-stack substitute applies if no second human reviewer is available.
- Cross-tenant integration test is a Review-Gate blocker per Constitution v1.4.0 Principle I — must be authored before `/speckit.implement` exits.
- Two follow-up artefacts owed by `/speckit.plan`: (a) `docs/runbooks/out-of-band-refund.md` (referenced by FR-011a), (b) F5.1 backlog ticket linked to the `allow_anonymous_paylink` flag + funnel-dropoff metric promotion criteria.
