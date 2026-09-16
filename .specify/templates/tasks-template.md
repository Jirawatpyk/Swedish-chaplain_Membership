---

description: "Task list template for feature implementation"
---

# Tasks: [FEATURE NAME]

**Input**: Design documents from `/specs/[###-feature-name]/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: MANDATORY (Constitution Principle II, NON-NEGOTIABLE). Every user story carries at least one acceptance test that is written first and observed RED before implementation; a story that touches a `tenant_id`-scoped table also carries a cross-tenant probe integration test (Review-Gate blocker). Write one task per behaviour the spec states, naming its test — not one task per test file. Generate from THIS template and the feature's spec/plan, never by copying an earlier feature's tasks.md.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- Bounded contexts: `src/modules/<context>/{domain,application,infrastructure}/` (public barrel `index.ts`; cross-context imports go through it)
- Presentation: `src/app/(staff)/admin/**`, `src/app/(member)/portal/**`, `src/app/api/**/route.ts`, `src/components/**`
- Tests: `tests/unit/<module>/`, `tests/contract/<module>/`, `tests/integration/<module>/` (live Neon `dev` branch), `tests/e2e/` (Playwright + axe, `--workers=1`)
- Migrations: hand-written SQL in `drizzle/migrations/` + `meta/_journal.json` entry (see CLAUDE.md § Gotchas)

<!-- 
  ============================================================================
  IMPORTANT: The tasks below are SAMPLE TASKS for illustration purposes only.
  
  The /speckit.tasks command MUST replace these with actual tasks based on:
  - User stories from spec.md (with their priorities P1, P2, P3...)
  - Feature requirements from plan.md
  - Entities from data-model.md
  - Endpoints from contracts/
  
  Tasks MUST be organized by user story so each story can be:
  - Implemented independently
  - Tested independently
  - Delivered as an MVP increment
  
  DO NOT keep these sample tasks in the generated tasks.md file.
  ============================================================================
-->

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [ ] T001 Create project structure per implementation plan
- [ ] T002 Initialize [language] project with [framework] dependencies
- [ ] T003 [P] Configure linting and formatting tools

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

Examples of foundational tasks (adjust based on your project):

- [ ] T004 Setup database schema and migrations framework
- [ ] T005 [P] Implement authentication/authorization framework
- [ ] T006 [P] Setup API routing and middleware structure
- [ ] T007 Create base models/entities that all stories depend on
- [ ] T008 Configure error handling and logging infrastructure
- [ ] T009 Setup environment configuration management

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - [Title] (Priority: P1) 🎯 MVP

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 1 (write first, observe RED)

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [ ] T010 [P] [US1] Acceptance test for [AS-1 behaviour] in tests/contract/<module>/[name].test.ts — RED before T012
- [ ] T011 [P] [US1] Live-Neon integration test for [use case] (+ cross-tenant probe if a `tenant_id` table is touched) in tests/integration/<module>/[name].test.ts — RED before T013

### Implementation for User Story 1

- [ ] T012 [P] [US1] Domain types/policies for [behaviour] in src/modules/<context>/domain/ (framework-free)
- [ ] T013 [US1] Use case + ports for [behaviour] in src/modules/<context>/application/use-cases/ (Result<T,E>; audit event on state change)
- [ ] T014 [US1] Repository/adapter in src/modules/<context>/infrastructure/ (threads `tx` from runInTenant) + migration if a table changes
- [ ] T015 [US1] Route/server action/UI in src/app/… with i18n keys in en/th/sv
- [ ] T016 [US1] Add validation and error handling
- [ ] T017 [US1] Add logging for user story 1 operations

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - [Title] (Priority: P2)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 2 (write first, observe RED)

- [ ] T018 [P] [US2] Acceptance test for [AS behaviour] in tests/contract/<module>/[name].test.ts — RED first
- [ ] T019 [P] [US2] Live-Neon integration test for [use case] in tests/integration/<module>/[name].test.ts — RED first

### Implementation for User Story 2

- [ ] T020 [P] [US2] Domain changes for [behaviour] in src/modules/<context>/domain/
- [ ] T021 [US2] Use case for [behaviour] in src/modules/<context>/application/use-cases/
- [ ] T022 [US2] Adapter/route/UI for [behaviour] (src/modules/<context>/infrastructure/, src/app/…)
- [ ] T023 [US2] Integrate with User Story 1 components (if needed)

**Checkpoint**: At this point, User Stories 1 AND 2 should both work independently

---

## Phase 5: User Story 3 - [Title] (Priority: P3)

**Goal**: [Brief description of what this story delivers]

**Independent Test**: [How to verify this story works on its own]

### Tests for User Story 3 (write first, observe RED)

- [ ] T024 [P] [US3] Acceptance test for [AS behaviour] in tests/contract/<module>/[name].test.ts — RED first
- [ ] T025 [P] [US3] Live-Neon integration test for [use case] in tests/integration/<module>/[name].test.ts — RED first

### Implementation for User Story 3

- [ ] T026 [P] [US3] Domain changes for [behaviour] in src/modules/<context>/domain/
- [ ] T027 [US3] Use case for [behaviour] in src/modules/<context>/application/use-cases/
- [ ] T028 [US3] Adapter/route/UI for [behaviour] (src/modules/<context>/infrastructure/, src/app/…)

**Checkpoint**: All user stories should now be independently functional

---

[Add more user story phases as needed, following the same pattern]

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] TXXX [P] Documentation updates in docs/
- [ ] TXXX Code cleanup and refactoring
- [ ] TXXX Performance optimization across all stories
- [ ] TXXX [P] Unit tests that close the Domain 100% / Application 80% coverage pins in tests/unit/<module>/ (only where the pins demand — no scratch checks)
- [ ] TXXX Security hardening
- [ ] TXXX Run quickstart.md validation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Final Phase)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - May integrate with US1 but should be independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - May integrate with US1/US2 but should be independently testable

### Within Each User Story

- Tests MUST be written and observed FAILING before implementation (commit red, then green)
- Models before services
- Services before endpoints
- Core implementation before integration
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel
- All Foundational tasks marked [P] can run in parallel (within Phase 2)
- Once Foundational phase completes, all user stories can start in parallel (if team capacity allows)
- All tests for a user story marked [P] can run in parallel
- Models within a story marked [P] can run in parallel
- Different user stories can be worked on in parallel by different team members

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: "Acceptance test for [AS-1 behaviour] in tests/contract/<module>/[name].test.ts"
Task: "Live-Neon integration test for [use case] in tests/integration/<module>/[name].test.ts"

# Launch all models for User Story 1 together:
Task: "Domain types/policies for [behaviour] in src/modules/<context>/domain/"
Task: "Use case + ports for [behaviour] in src/modules/<context>/application/use-cases/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL - blocks all stories)
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!)
3. Add User Story 2 → Test independently → Deploy/Demo
4. Add User Story 3 → Test independently → Deploy/Demo
5. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1
   - Developer B: User Story 2
   - Developer C: User Story 3
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing; commit tests only where the spec states the behaviour (one focused test per behaviour, sized like the neighbouring files)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
