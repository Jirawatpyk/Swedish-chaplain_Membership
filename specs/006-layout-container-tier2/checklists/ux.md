# UX + Migration + Test-Strategy Requirements Quality Checklist: Layout Container Tier 2

**Purpose**: "Unit tests for English" — validate that the spec, plan, and research documents express UX, migration, and test-strategy requirements with enough completeness, clarity, consistency, and measurability for a reviewer to gate the PR.
**Created**: 2026-04-18
**Last audit**: 2026-04-18 (author self-audit before `/speckit.tasks`)
**Feature**: [spec.md](../spec.md)

> Tick each item when the requirement *as written* is unambiguous and testable. All 41 items ticked = spec is ready for `/speckit.tasks`.

## Requirement Completeness

- [x] CHK001 Is the Content-Type Mapping complete, covering every current admin and portal route plus documented future routes? [Completeness, Spec §Assumptions Content-Type-Mapping] — **resolved**: 19 routes enumerated (3 + 10 + 6) verified by filesystem `find` command.
- [x] CHK002 Are requirements specified for every one of the 19 migrated routes, not only the 3 categories? [Completeness, Spec §Assumptions + §FR-006] — **resolved**: mapping lists each route by name; any route not listed is out of scope.
- [x] CHK003 Are skeleton (`loading.tsx`) parity requirements defined for every migrated route, not just "where present"? [Completeness, Spec §FR-007] — **resolved**: FR-007 now says "Every one of the 19 migrated routes MUST have its sibling `loading.tsx`..."
- [x] CHK004 Are responsive behaviour requirements defined for all three containers at the <768 / 768–1279 / ≥1280 viewport bands? [Completeness, Spec §FR-011] — **resolved**: FR-011 enumerates three bands (a)/(b)/(c).
- [x] CHK005 Are `docs/ux-standards.md` update deliverables enumerated (decision rule, mapping table, 3 code examples, removal notice)? [Completeness, Spec §FR-008]
- [x] CHK006 Are test-strategy requirements enumerated across unit + depth E2E + breadth E2E + CLS + CI static check? [Completeness, Plan §Constitution II + Project Structure]

## Requirement Clarity

- [x] CHK007 Are the three width values expressed consistently in `rem` with pixel equivalents stated once, and never restated as "approximately" after the Clarifications lock? [Clarity, Spec §FR-002/003/004 + §Clarifications]
- [x] CHK008 Is "primary content type" defined with a concrete disambiguation rule for mixed-content pages (e.g., summary cards + embedded table)? [Clarity, Spec §Edge Cases + Research §R5] — resolved via Research R5 precedent rule ("author picks primary; embedded wider content uses local overflow-x-auto per FR-015") + Assumptions pre-ship Review-gate check for `/admin/plans/[year]/[planId]`.
- [x] CHK009 Is "persistent chrome" enumerated (sidebar, top bar, breadcrumbs) wherever SC-007 or FR-013 references it? [Clarity, Spec §SC-007 + §FR-013]
- [x] CHK010 Is the ≥1280px viewport threshold stated identically wherever "zero horizontal scroll" is required? [Clarity, Spec §SC-005 + §FR-002]
- [x] CHK011 Is "average line length ≤80 chars" on form pages defined with a measurement method (sampled pages, sampled text type)? [Clarity, Spec §SC-006] — **resolved**: SC-006 now specifies exact measurement method (9 samples × 3 pages, formula `width / 1em`, manual Review-gate).

## Requirement Consistency

- [x] CHK012 Do the width caps in FR-002/003/004 match the Clarifications session and Assumptions verbatim? [Consistency, Spec §Clarifications + §FR-002/003/004 + §Assumptions]
- [x] CHK013 Do success criteria SC-001/002/003 reference the same three container names used by FR-002/003/004? [Consistency, Spec §SC-001-003 vs §FR]
- [x] CHK014 Does FR-009 (hard-remove ContentContainer) agree with SC-004 (grep returns zero) and the Clarifications Q2 answer? [Consistency, Spec §FR-009 + §SC-004 + §Clarifications]
- [x] CHK015 Does the non-regression bullet in Assumptions agree with SC-003 (±0 px at 1440px)? [Consistency, Spec §Assumptions + §SC-003]
- [x] CHK016 Is the Thai line-break hedge referenced consistently across `research.md §R9b`, `plan.md` globals.css note, and spec? [Consistency, Research §R9b + Plan + Spec §FR-017]

## Acceptance Criteria Quality / Measurability

- [x] CHK017 Is SC-005 (zero horizontal scroll) tied to a specific assertion mechanism (`documentElement.scrollWidth === clientWidth`)? [Measurability, Spec §SC-005]
- [x] CHK018 Is SC-007 (CLS ≤0.02) paired with a concrete measurement harness (Playwright `PerformanceObserver` on a form→table transition)? [Measurability, Spec §SC-007]
- [x] CHK019 Is SC-003 ("±0 px at 1440px") testable by class-name + `getComputedStyle` without a screenshot baseline? [Measurability, Spec §SC-003]
- [x] CHK020 Can SC-001/002/003 be verified by a single deterministic rule per page (which container imported), not by subjective review? [Measurability, Spec §SC-001-003 + §Assumptions CI static check]
- [x] CHK021 Is SC-009 (documentation shipped in the same PR) measurable by PR file-scope inspection? [Measurability, Spec §SC-009]

## Scenario Coverage

- [x] CHK022 Are requirements defined for route transitions between *different* container types (form → table, detail → form, etc.)? [Coverage, Spec §FR-013 + §SC-007]
- [x] CHK023 Are requirements defined for embedded tables inside DetailContainer (plan detail page)? [Coverage, Spec §FR-015 + §FR-019 + §Assumptions overflow-ownership + pre-ship Review-gate check]
- [x] CHK024 Are non-regression requirements explicitly stated for DetailContainer-category pages (not only implied)? [Coverage, Spec §Assumptions non-regression bullet]
- [x] CHK025 Are test-coverage requirements explicit about depth (3 pages × 3 widths) AND breadth (all 19 pages × 1 width)? [Coverage, Plan §Constitution II]

## Edge Case Coverage

- [x] CHK026 Are requirements defined for ultrawide viewports (≥2560px) — does TableContainer stay capped at 96rem or expand? [Coverage, Spec §FR-002 cap + §Edge Cases] — remains capped at 96rem.
- [x] CHK027 Are requirements specified for viewports <768px (mobile collapse behaviour) for all three containers? [Coverage, Spec §FR-011(a) + §Edge Cases]
- [x] CHK028 Is behaviour specified when a raw `<table>` (not shadcn `<Table>`) appears inside any container? [Coverage, Spec §FR-015]
- [x] CHK029 Are print stylesheet requirements addressed or explicitly declared out of scope? [Coverage, Spec §Edge Cases] — @media print preserved; no container override.
- [x] CHK030 Is sidebar-collapsed-vs-expanded effect on container width explicitly handled (no layout shift beyond existing transition)? [Coverage, Spec §Edge Cases]

## Non-Functional Requirements

- [x] CHK031 Are WCAG 2.1 AA preservation requirements stated with an explicit verification mechanism (axe-core suite remains green)? [NFR, Spec §FR-010] — **resolved**: FR-010 now names `@axe-core/playwright` as the verification mechanism and makes new failing rules a merge blocker.
- [x] CHK032 Is the Thai line-break hedge (`:lang(th) { line-break: loose; word-break: normal; }`) captured in the spec surface that reviewers read, or only in research? [NFR, Spec §FR-017 + §Assumptions Thai-line-break bullet]
- [x] CHK033 Are LCP / INP explicitly declared out of scope, leaving only CLS (SC-007) as the performance NFR for this feature? [NFR, Spec §FR-016 + §Assumptions Performance-scope bullet]
- [x] CHK034 Are i18n requirements confirmed as "no new keys, no new strings" at the spec level, not only at the plan level? [NFR, Spec §FR-005 + §FR-018(b)]

## Dependencies & Assumptions

- [x] CHK035 Is the dependency on F3 ship stated with a concrete unblocking condition (e.g., "branch 005 merged to main")? [Dependency, Spec §Assumptions F3-ship bullet]
- [x] CHK036 Is the assumption "shadcn `<Table>` owns horizontal overflow" surfaced in the spec, not only in research R5 + quickstart? [Assumption, Spec §FR-015 + §FR-019 + §Assumptions overflow-ownership bullet]
- [x] CHK037 Is the assumption "no new dependencies, no i18n keys, no API or schema changes" explicitly restated as a gate, not just a passing mention? [Assumption, Spec §FR-018 (Scope gate)] — **resolved**: FR-018 is a single merge-blocking gate enumerating 7 forbidden diff surfaces.
- [x] CHK038 Is the pre-ship human check for `/admin/plans/[year]/[planId]` elevated to a Review-gate requirement or only a research note? [Assumption, Spec §Assumptions Pre-ship-Review-gate-check bullet]

## Ambiguities & Conflicts

- [x] CHK039 Is the case "table's natural width >96rem at 1280px" acknowledged — does it conflict with SC-005 (zero horizontal scroll)? [Conflict/Ambiguity resolved, Spec §FR-019] — **resolved**: FR-019 reconciles by scoping SC-005 to the document body, delegating inner table overflow to shadcn `<Table>`'s `overflow-x-auto` wrapper.
- [x] CHK040 Is the content-type classification for `/admin/plans/[year]/[planId]` unambiguous, given mixed content and a human pre-ship override? [Ambiguity, Spec §Assumptions + Research §R5] — classified DetailContainer with Review-gate override path; unambiguous.
- [x] CHK041 Is the Thai-readability concern (X1) either integrated into the spec or explicitly deferred with a written decision? [Ambiguity, Spec §FR-017 + Research §R9b] — integrated as FR-017 + research R9b; no deferral.

## Notes

- Each item tests **what is written** in spec/plan/research, not what the code does.
- All 41 items now ticked after author self-audit (2026-04-18). Added spec deltas: Content-Type Mapping enumeration, FR-007 "every route", FR-010 axe-core mechanism, FR-011 three-band responsive, FR-018 scope gate, FR-019 SC-005 body-scope, SC-006 measurement method.
- Items are numbered sequentially (CHK001–CHK041); append future items at CHK042+.
- Traceability references: `[Spec §…]`, `[Plan §…]`, `[Research §…]`, `[Quickstart …]`, or the markers `[Gap]`, `[Ambiguity]`, `[Conflict]`, `[Assumption]`.
