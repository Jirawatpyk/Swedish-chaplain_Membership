# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]
**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]  
**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]  
**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]  
**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]  
**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]
**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]  
**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]  
**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]  
**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.0.0*

**NON-NEGOTIABLE gates** (any FAIL blocks the plan; no waivers):

- [ ] **I. Data Privacy & Security** — Lawful basis + purpose documented for any new PII
      touched; RBAC checks on every new protected route; OWASP risks for touched surfaces
      identified and mitigated; TLS 1.2+ and at-rest encryption confirmed for new data.
- [ ] **II. Test-First Development** — Failing tests (contract / acceptance) planned BEFORE
      implementation tasks; coverage targets (≥80% business, 100% security-critical) stated.
- [ ] **III. Clean Architecture** — New code maps to Presentation / Application / Domain /
      Infrastructure with the dependency rule preserved; no framework/ORM types leak out
      of Infrastructure; module boundaries named.
- [ ] **IV. Payment Security (PCI DSS)** — If payment is touched: no raw PAN/CVV stored or
      logged; processor tokenization only; audit events listed; SAQ scope unchanged.

**Core principle gates** (FAIL must be justified in Complexity Tracking):

- [ ] **V. Internationalization (SV/EN)** — All new user-facing strings use i18n keys;
      SV + EN resources planned; locale-aware formatting for dates/numbers/currency.
- [ ] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Designs start at 320px;
      WCAG 2.1 AA conformance checklist attached; shared component library used.
- [ ] **VII. Performance & Observability** — Performance budgets (LCP <2.5s, INP <200ms,
      CLS <0.1; API p95 <400ms) stated; logging / metrics / traces plan listed.
- [ ] **VIII. Reliability** — Error paths enumerated; transactional boundaries defined;
      idempotency keys on money/state-changing endpoints; audit-log entries listed.
- [ ] **IX. Code Quality Standards** — TypeScript strict, ESLint clean, Conventional
      Commits, and review requirements (≥1 / ≥2 for sensitive code) acknowledged.
- [ ] **X. Simplicity (YAGNI)** — No speculative abstractions; any added complexity
      recorded in Complexity Tracking with rejected simpler alternative.

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
