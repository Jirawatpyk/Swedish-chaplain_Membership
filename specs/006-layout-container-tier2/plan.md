# Implementation Plan: Layout Container Tier 2 — Content-Type-Based Width System

**Branch**: `006-layout-container-tier2` | **Date**: 2026-04-18 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-layout-container-tier2/spec.md`

## Summary

Replace the single `ContentContainer` (F4, 72rem) with three content-type-aware layout primitives — `TableContainer` (96rem), `DetailContainer` (72rem), `FormContainer` (42rem) — and migrate all 19 admin + portal routes (plus their `loading.tsx` skeletons) to the correct container per the Content-Type Mapping locked in spec Assumptions. Pure presentation-layer refactor: no Domain / Application / Infrastructure change, no new dependencies, no i18n keys, no schema or audit events. Verification via Playwright viewport assertions (`scrollWidth <= clientWidth`) on one representative page per category × 3 viewport widths, plus unit tests asserting rendered `max-width` class on each primitive. `ContentContainer` is removed outright in the same PR — build fails on reintroduction.

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (existing F1–F4 config; no change)
**Primary Dependencies**: Next.js 16 App Router, React 19, Tailwind CSS v4, shadcn/ui (no new deps)
**Storage**: N/A (presentation-only)
**Testing**: Vitest (unit, rendered className assertions) + Playwright (viewport + scroll-width assertions); reuses existing harness
**Target Platform**: Web (Vercel sin1, existing deploy)
**Project Type**: Web application (Next.js App Router, existing structure)
**Performance Goals**: CLS ≤0.02 on persistent chrome during route transitions between container types (SC-007); no new LCP/INP regressions.
**Constraints**:

- Zero visual regression on DetailContainer-categorised pages (pixel-exact 72rem at 1440px).
- Zero horizontal scroll on TableContainer pages at viewport ≥1280px (SC-005).
- Form line length ≤80 chars on FormContainer pages (SC-006).
- Existing ≥800 unit+contract and ≥300 integration tests must stay green (SC-008).

**Scale/Scope**: 19 migrated routes + matching `loading.tsx` skeletons; 3 new primitives; 1 legacy primitive removed; 1 ux-standards doc section added.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.4.0*

**NON-NEGOTIABLE gates**:

- [x] **I. Data Privacy & Security** — N/A: no PII touched, no new protected routes, no new data paths. Route-level RBAC unchanged.
- [x] **II. Test-First Development** — Acceptance tests authored first: (a) Vitest unit spec per primitive asserting rendered class/max-width, (b) Playwright depth probe at 1280/1440/1920 on one page per category, (c) Playwright breadth probe across all 19 migrated routes @1440px asserting `[data-slot="layout-container"]` + no body scroll, (d) Playwright CLS measurement on form→table transition (SC-007), (e) CI script `check-layout-container-usage.ts` fails build if a page.tsx imports zero or multiple containers.
- [x] **III. Clean Architecture** — Change is confined to `src/components/layout/**` and `src/app/**` (Presentation). No imports from Domain / Application / Infrastructure; no ORM / framework types cross boundaries.
- [x] **IV. Payment Security (PCI DSS)** — N/A: payment surfaces untouched.

**Core principle gates**:

- [x] **V. Internationalization (SV/EN/TH)** — No new user-facing strings; containers render `children` only.
- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Containers collapse to full width minus existing gutter on <768px (FR-011). No change to focus order, landmarks, or ARIA. WCAG 2.1 AA preserved (FR-010).
- [x] **VII. Performance & Observability** — CLS budget ≤0.02 captured in SC-007; no new logs, metrics, or traces required (pure presentation).
- [x] **VIII. Reliability** — N/A: no error paths, no transactional boundaries, no money/state-changing endpoints, no new audit events.
- [x] **IX. Code Quality Standards** — TS strict, ESLint clean, Conventional Commits, standard single-reviewer threshold (no auth / RBAC / payment / PII / audit / GDPR surface touched).
- [x] **X. Simplicity (YAGNI)** — Three named primitives replace one generic one. Each encodes a single content type, eliminating the `variant='admin' | 'portal'` + `fullBleed` guessing that produced the F4 width problem. Minimal, non-speculative.

**Result**: All gates pass. No Complexity Tracking entries required.

## Project Structure

### Documentation (this feature)

```text
specs/006-layout-container-tier2/
├── plan.md              # This file
├── spec.md              # Feature spec (clarified)
├── research.md          # Phase 0: width-cap decisions, migration mapping, ContentContainer teardown
├── data-model.md        # Phase 1: component prop contracts (no persistent data)
├── quickstart.md        # Phase 1: developer guide — picking a container + migrating a page
├── contracts/
│   └── layout-containers.md  # Phase 1: public API of each primitive
├── checklists/
│   └── requirements.md  # From /speckit.specify (already created)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
src/
├── components/
│   └── layout/
│       ├── table-container.tsx        # NEW — 96rem cap
│       ├── detail-container.tsx       # NEW — 72rem cap
│       ├── form-container.tsx         # NEW — 42rem cap
│       ├── content-container.tsx      # REMOVED after migration
│       ├── index.ts                   # UPDATED — barrel exports the three new primitives
│       ├── page-header.tsx            # unchanged
│       ├── breadcrumb-nav.tsx         # unchanged
│       └── …                          # other layout primitives unchanged
└── app/
    ├── (staff)/admin/**               # ~11 routes migrated per Content-Type Mapping
    └── (member)/portal/**             # ~8 routes migrated per Content-Type Mapping

tests/
├── unit/components/layout/
│   ├── table-container.test.tsx       # NEW — renders 96rem class, fullBleed opt-out absent (locked), children passthrough
│   ├── detail-container.test.tsx      # NEW — renders 72rem class, pixel-parity with former ContentContainer
│   └── form-container.test.tsx        # NEW — renders 42rem class
└── e2e/layout/
    ├── container-widths.spec.ts       # NEW — Playwright depth probe. Built incrementally across Phases 3/4/5 (one parametric block per container type: table in US1, form in US2, detail in non-regression phase). Covers representative page × {375, 1280, 1440, 1920} widths.
    ├── all-pages-containers.spec.ts   # NEW — parametric sweep of ALL 19 migrated routes @1440px (breadth probe): every page has `[data-slot="layout-container"]` AND `scrollWidth === clientWidth`
    └── cls-container-transition.spec.ts # NEW — Playwright PerformanceObserver measures CLS on form→table route transition; asserts ≤0.02

scripts/
└── check-layout-container-usage.ts    # NEW — CI script: greps every page.tsx under src/app/(staff|member)/** and fails if zero or multiple of {TableContainer, FormContainer, DetailContainer} are imported

docs/
└── ux-standards.md                    # UPDATED — Container Selection Guideline section

src/app/
└── globals.css                        # UPDATED — (1) replace `--content-max-width-admin` / `--content-max-width-portal` tokens with `--layout-max-width-{form,detail,table}` (42/72/96 rem); (2) add `:lang(th) { line-break: loose; word-break: normal; }` as a Thai-readability hedge so browsers use ICU Thai dictionary line-breaking inside narrow containers (FormContainer 42rem in particular)
```

**Structure Decision**: Presentation-only change contained to `src/components/layout/**`, `src/app/**` route trees, `tests/unit/components/layout/**`, `tests/e2e/layout/**`, and `docs/ux-standards.md`. No module boundary changes, no migrations, no API contracts.

## Complexity Tracking

No violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| *(none)*  | —          | —                                   |
