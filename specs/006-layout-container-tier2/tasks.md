---
description: "Task list for Layout Container Tier 2"
---

# Tasks: Layout Container Tier 2 — Content-Type-Based Width System

**Input**: Design documents from `/specs/006-layout-container-tier2/`
**Prerequisites**: plan.md, spec.md (v post-critique), research.md (R1–R11), data-model.md, contracts/layout-containers.md, quickstart.md

**Tests**: Required. Test-First Development is NON-NEGOTIABLE (Constitution Principle II). Tests precede the implementation they cover.

**Organization**: Phases map to spec Assumptions + user stories. US1 (table pages, P1) and US2 (form pages, P2) are the two user stories; detail-page migration is a non-regression phase (from Assumptions, no user story per post-critique spec).

## Format: `[ID] [P?] [Story] Description with exact file path`

- **[P]** — parallelisable (different files, no dep on incomplete tasks)
- **[US1]** / **[US2]** — maps to spec user stories
- No story label = Setup / Foundational / Non-regression / Polish

---

## Phase 1 — Setup

- [ ] T001 Verify branch `006-layout-container-tier2` is checked out and up to date with `main` (must be post-F3 merge per Spec §Assumptions F3-dependency).
- [ ] T002 Run `pnpm install` to confirm no new dependencies are required (Spec §FR-018 scope gate forbids new deps).

## Phase 2 — Foundational (blocks US1, US2, and detail migration)

**Goal**: Land the three primitives, their unit tests, CSS tokens, barrel exports, and the CI static check BEFORE any page migration. Everything here is reversible without breaking `main`.

### 2a. Unit tests (TDD — RED before implementation)

- [ ] T003 [P] Write failing unit test `tests/unit/components/layout/table-container.test.tsx` asserting (a) renders children, (b) root has `data-slot="layout-container"` + `data-variant="table"`, (c) computed `max-width` equals `var(--layout-max-width-table)` (96rem), (d) merges custom `className`, (e) **FR-015 negative assertion** — root's computed `overflow-x` is `visible` (NOT `auto`/`scroll`/`hidden`); the container must never own horizontal scroll.
- [ ] T004 [P] Write failing unit test `tests/unit/components/layout/form-container.test.tsx` asserting the same five invariants with `data-variant="form"` and `--layout-max-width-form` (42rem).
- [ ] T005 [P] Write failing unit test `tests/unit/components/layout/detail-container.test.tsx` asserting the same five invariants with `data-variant="detail"` and `--layout-max-width-detail` (72rem).
- [ ] T006 Commit RED test suite (three specs failing). Conventional Commits prefix: `test(layout): add failing unit tests for tier-2 containers`.

### 2b. CSS tokens + Thai hedge

- [ ] T007 Edit `src/app/globals.css` to add `--layout-max-width-form: 42rem`, `--layout-max-width-detail: 72rem`, `--layout-max-width-table: 96rem` under `:root`. DO NOT remove the legacy `--content-max-width-admin` / `--content-max-width-portal` tokens yet — they are deleted in Phase 6 after all pages are migrated.
- [ ] T008 In the same file, add the Thai line-break hedge block: `:lang(th) { line-break: loose; word-break: normal; }` per Spec §FR-017.

### 2c. Primitives

- [ ] T009 [P] Create `src/components/layout/table-container.tsx` — server-component-safe `<div>` with `data-slot="layout-container"`, `data-variant="table"`, classes `mx-auto w-full max-w-[var(--layout-max-width-table)] px-[var(--page-padding-x)] py-[var(--page-padding-y)]`, `cn()`-merged `className`. Props: `{ children: ReactNode; className?: string }`. No `variant`, no `fullBleed`.
- [ ] T010 [P] Create `src/components/layout/form-container.tsx` — identical structure, `data-variant="form"`, token `--layout-max-width-form`.
- [ ] T011 [P] Create `src/components/layout/detail-container.tsx` — identical structure, `data-variant="detail"`, token `--layout-max-width-detail`.
- [ ] T012 Update `src/components/layout/index.ts` barrel: add `export { TableContainer } from './table-container';`, `export { FormContainer } from './form-container';`, `export { DetailContainer } from './detail-container';`. Keep legacy `ContentContainer` export for now (deleted Phase 6).
- [ ] T013 Run `pnpm test tests/unit/components/layout` and confirm all three primitive specs now GREEN. Commit: `feat(layout): add tier-2 layout container primitives`.

### 2d. CI static check (scope-gate enforcement)

- [ ] T014 Create `scripts/check-layout-container-usage.ts` — Node/TS script that: (a) globs `src/app/(staff)/**/page.tsx` and `src/app/(member)/**/page.tsx`, (b) for each file reads source and counts imports from `@/components/layout` of `{TableContainer, FormContainer, DetailContainer}`, (c) fails with non-zero exit if any page imports zero or multiple of them. Output lists offending files.
- [ ] T015 Add `check:layout` script to `package.json` → `"check:layout": "tsx scripts/check-layout-container-usage.ts"`.
- [ ] T016 Wire `check:layout` into two places: (a) append `pnpm check:layout` to the full-CI chain documented in `CLAUDE.md` Commands section (the `pnpm lint && pnpm typecheck && ... && pnpm test:e2e` reproducer), and (b) add it to `.husky/pre-push` (or the existing pre-push hook). No `.github/workflows/` exists in this repo — CI runs via Vercel build + Husky hooks. At Phase 2 boundary the script MUST fail because no pages import the new containers yet — that's correct; it starts passing as migration progresses.

---

## Phase 3 — User Story 1 (P1): Table-dense pages widen to 96rem

**Story goal**: Admins open `/admin/users`, `/admin/plans`, `/admin/members` and see no horizontal scroll at 1280/1440/1920px viewports. Tables use the full 96rem content area.

**Independent test**: After this phase, `pnpm test:e2e --grep "container-widths.*table"` passes; manual spot check at 1920px shows wide tables.

### 3a. E2E depth test (RED)

- [ ] T017 [US1] Create failing Playwright spec `tests/e2e/layout/container-widths.spec.ts` with a parametric block for TableContainer — for each `{width: 375, 1280, 1440, 1920}` × representative page `/admin/members` asserts `document.documentElement.scrollWidth === document.documentElement.clientWidth` AND `[data-slot="layout-container"][data-variant="table"]` exists AND container width behaves per FR-011: at 375px (mobile band) the container takes full width minus `--page-padding-x` gutter; at ≥1280px it caps at ≤1536px (96rem). Spec must currently fail because the page still uses ContentContainer. Commit RED.

### 3b. Migrate pages (3 table-dense routes)

- [ ] T018 [P] [US1] Migrate `src/app/(staff)/admin/users/page.tsx` — replace `ContentContainer` import + element with `TableContainer`; drop any `variant` / `fullBleed` props.
- [ ] T019 [P] [US1] Migrate `src/app/(staff)/admin/plans/page.tsx` — same replacement.
- [ ] T020 [P] [US1] Migrate `src/app/(staff)/admin/members/page.tsx` — same replacement.

### 3c. Migrate loading skeletons (per FR-007)

- [ ] T021 [P] [US1] Migrate `src/app/(staff)/admin/plans/loading.tsx` — wrap skeleton in `TableContainer`.
- [ ] T022 [P] [US1] Migrate `src/app/(staff)/admin/members/loading.tsx` — wrap skeleton in `TableContainer`.
- [ ] T023 [US1] If `src/app/(staff)/admin/users/loading.tsx` does not exist, create it wrapping a members-style skeleton in `TableContainer`. Per Spec §FR-007 "every one of the 19 migrated routes MUST have `loading.tsx`".

### 3d. Green check

- [ ] T024 [US1] Run `pnpm test:e2e --grep "container-widths"` and confirm table block is GREEN. Commit: `feat(layout): [US1] migrate admin table pages to TableContainer`.

---

## Phase 4 — User Story 2 (P2): Form-focused pages constrained to 42rem

**Story goal**: Users open any form/settings/edit route and see a ≤42rem column with comfortable line length.

**Independent test**: `pnpm test:e2e --grep "container-widths.*form"` passes; SC-006 manual measurement recorded in PR description.

### 4a. E2E depth test (RED)

- [ ] T025 [US2] Extend `tests/e2e/layout/container-widths.spec.ts` with a FormContainer block — for representative `/admin/settings/fees` at 375/1280/1440/1920 asserts `[data-variant="form"]` present AND container width behaves per FR-011: at 375px full-width minus gutter; at ≥1280px sits between 650 and 680 (42rem ≈672px ±8px); no horizontal body scroll at any tested viewport. Currently RED.

### 4b. Migrate pages (10 form routes)

- [ ] T026 [P] [US2] Migrate `src/app/(staff)/admin/account/page.tsx` → `FormContainer`.
- [ ] T027 [P] [US2] Migrate `src/app/(staff)/admin/settings/fees/page.tsx` → `FormContainer`.
- [ ] T028 [P] [US2] Migrate `src/app/(staff)/admin/plans/new/page.tsx` → `FormContainer`.
- [ ] T029 [P] [US2] Migrate `src/app/(staff)/admin/plans/clone/page.tsx` → `FormContainer`.
- [ ] T030 [P] [US2] Migrate `src/app/(staff)/admin/plans/[year]/[planId]/edit/page.tsx` → `FormContainer`.
- [ ] T031 [P] [US2] Migrate `src/app/(staff)/admin/members/new/page.tsx` → `FormContainer`.
- [ ] T032 [P] [US2] Migrate `src/app/(staff)/admin/members/[memberId]/edit/page.tsx` → `FormContainer`.
- [ ] T033 [P] [US2] Migrate `src/app/(member)/portal/account/page.tsx` → `FormContainer`.
- [ ] T034 [P] [US2] Migrate `src/app/(member)/portal/edit/page.tsx` → `FormContainer`.
- [ ] T035 [P] [US2] Migrate `src/app/(member)/portal/contacts/invite/page.tsx` → `FormContainer`.

### 4c. Migrate loading skeletons

- [ ] T036 [P] [US2] Migrate `src/app/(staff)/admin/account/loading.tsx` → `FormContainer` (create if missing).
- [ ] T037 [P] [US2] Migrate `src/app/(staff)/admin/plans/new/loading.tsx` → `FormContainer` (create if missing).
- [ ] T038 [P] [US2] Migrate `src/app/(staff)/admin/plans/clone/loading.tsx` → `FormContainer` (create if missing).
- [ ] T039 [P] [US2] Migrate `src/app/(staff)/admin/plans/[year]/[planId]/edit/loading.tsx` → `FormContainer` (create if missing).
- [ ] T040 [P] [US2] Migrate `src/app/(staff)/admin/members/new/loading.tsx` → `FormContainer` (create if missing).
- [ ] T041 [P] [US2] Migrate `src/app/(staff)/admin/members/[memberId]/edit/loading.tsx` → `FormContainer` (create if missing).
- [ ] T042 [P] [US2] Migrate `src/app/(member)/portal/account/loading.tsx` → `FormContainer`.
- [ ] T043a [P] [US2] Ensure `src/app/(staff)/admin/settings/fees/loading.tsx` exists (create if missing) wrapping a form-shaped skeleton in `FormContainer`.
- [ ] T043b [P] [US2] Ensure `src/app/(member)/portal/edit/loading.tsx` exists (create if missing) wrapping a form-shaped skeleton in `FormContainer`.
- [ ] T043c [P] [US2] Ensure `src/app/(member)/portal/contacts/invite/loading.tsx` exists (create if missing) wrapping a form-shaped skeleton in `FormContainer`.

### 4d. SC-006 manual measurement (Review-gate)

- [ ] T044 [US2] Perform manual SC-006 measurement per spec: open `/admin/settings/fees`, `/admin/plans/new`, `/portal/account` @1440px EN locale; sample 3 body-text nodes per page; record `characters-per-line = width / 1em` in PR description; confirm mean ≤80.

### 4e. Green check

- [ ] T045 [US2] Run `pnpm test:e2e --grep "container-widths"` and confirm form block is GREEN. Commit: `feat(layout): [US2] migrate form pages to FormContainer`.

---

## Phase 5 — Non-regression: Detail-page migration (from Assumptions)

**Goal**: Migrate 6 detail/mixed pages to `DetailContainer` with pixel-exact parity to the old `ContentContainer` (72rem at 1440px). No user-visible change.

**Independent test**: SC-003 pixel-parity assertion + plan-detail page pre-ship Review-gate check.

### 5a. E2E depth + parity test (RED)

- [ ] T046 Extend `tests/e2e/layout/container-widths.spec.ts` with a DetailContainer block — for representative `/admin` at 375/1440px asserts `[data-variant="detail"]` present AND container width behaves per FR-011: at 375px full-width minus gutter; at 1440px exactly 1152 ±4 px (72rem pixel parity per SC-003); no horizontal body scroll at any tested viewport. Currently RED.

### 5b. Migrate pages (6 detail routes)

- [ ] T047 [P] Migrate `src/app/(staff)/admin/page.tsx` → `DetailContainer`.
- [ ] T048 [P] Migrate `src/app/(staff)/admin/plans/[year]/[planId]/page.tsx` → `DetailContainer`.
- [ ] T049 [P] Migrate `src/app/(staff)/admin/members/[memberId]/page.tsx` → `DetailContainer`.
- [ ] T050 [P] Migrate `src/app/(staff)/admin/members/[memberId]/timeline/page.tsx` → `DetailContainer`.
- [ ] T051 [P] Migrate `src/app/(member)/portal/page.tsx` → `DetailContainer`.
- [ ] T052 [P] Migrate `src/app/(member)/portal/profile/page.tsx` → `DetailContainer`.

### 5c. Migrate loading skeletons

- [ ] T053 [P] Migrate `src/app/(staff)/admin/loading.tsx` → `DetailContainer`.
- [ ] T054 [P] Migrate `src/app/(staff)/admin/plans/[year]/[planId]/loading.tsx` → `DetailContainer`.
- [ ] T055 [P] Migrate `src/app/(staff)/admin/members/[memberId]/loading.tsx` → `DetailContainer`.
- [ ] T056 [P] Migrate `src/app/(staff)/admin/members/[memberId]/timeline/loading.tsx` → `DetailContainer`.
- [ ] T057 [P] Migrate `src/app/(member)/portal/loading.tsx` → `DetailContainer`.
- [ ] T058 [P] Migrate `src/app/(member)/portal/profile/loading.tsx` → `DetailContainer` (create if missing).

### 5d. Pre-ship plan-detail Review-gate check (Spec §Assumptions)

- [ ] T059 Render `/admin/plans/[year]/[planId]` with a realistic plan containing ≥5 members; verify the embedded members-by-plan table reads cleanly inside 72rem with shadcn `<Table>`'s `overflow-x-auto` wrapper absorbing any excess. If cramped, reclassify to `TableContainer` (edit T048 + update Spec §Assumptions Content-Type Mapping) and add a changelog note.

### 5e. Green check

- [ ] T060 Run `pnpm test:e2e --grep "container-widths"` and confirm detail block is GREEN. Commit: `feat(layout): migrate detail pages to DetailContainer (non-regression)`.

---

## Phase 6 — Cross-cutting tests + teardown

### 6a. Breadth probe

- [ ] T061 Create `tests/e2e/layout/all-pages-containers.spec.ts` — parametric sweep over all 19 migrated routes at 1440px. For each route asserts: (a) exactly one `[data-slot="layout-container"]` present, (b) `document.documentElement.scrollWidth === clientWidth`. Commit.

### 6b. CLS measurement

- [ ] T062 Create `tests/e2e/layout/cls-container-transition.spec.ts` — Playwright test navigating from `/admin/settings/fees` (form) to `/admin/members` (table), collects CLS via `PerformanceObserver({ type: 'layout-shift' })` for the duration of the transition, asserts total CLS ≤0.02 on persistent chrome (sidebar, top bar, breadcrumbs). Per Spec §SC-007.

### 6c. Pre-existing test teardown (per Research §R10)

- [ ] T063 Delete `tests/unit/layout/content-container.test.tsx` — replaced by the three new primitive specs from Phase 2.
- [ ] T064 Rewrite `tests/e2e/layout-consistency.spec.ts` — replace "every admin page has max-width 1152px" with per-category assertions: `[data-variant="table"]` ≤ 1536px, `[data-variant="detail"]` = 1152±4px, `[data-variant="form"]` ≈ 672±8px.
- [ ] T065 Update `tests/e2e/empty-state-composition.spec.ts` — replace `ContentContainer` reference with `DetailContainer` (empty states typically render on detail/dashboard pages).
- [ ] T066 Rewrite `tests/e2e/portal-layout.spec.ts` (T043 of F4) — replace `variant="portal"` (64rem) assertion with the portal page's new container per Content-Type Mapping (DetailContainer for `/portal`, FormContainer for `/portal/account`, etc.).

### 6d. Delete legacy ContentContainer

- [ ] T067 Delete `src/components/layout/content-container.tsx`.
- [ ] T068 Remove `ContentContainer` export from `src/components/layout/index.ts`.
- [ ] T069 Remove `--content-max-width-admin` and `--content-max-width-portal` tokens from `src/app/globals.css`.
- [ ] T070 Run `pnpm typecheck` and confirm zero remaining `ContentContainer` imports anywhere in the repo (per Spec §SC-004). If any surface, fix in-place. Commit: `refactor(layout): remove legacy ContentContainer`.

### 6e. CI static check must now pass

- [ ] T071 Run `pnpm check:layout` and confirm it exits 0 (all 19 pages import exactly one of the three containers).

---

## Phase 7 — Polish (docs + final validation)

### 7a. Documentation

- [ ] T072 Update `docs/ux-standards.md` with the "Container Selection Guideline" section per Spec §FR-008: (a) one-line decision rule, (b) full Content-Type Mapping table (19 current routes), (c) three minimal code examples — one per primitive, (d) explicit note that `ContentContainer` has been removed. Add a Table of Contents entry (per Spec §SC-009).

### 7b. Full CI sweep

- [ ] T073 Run full local CI reproducer: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e`. Confirm ALL green. Zero new failures attributable to this feature (Spec §SC-008).

### 7c. Manual verification

- [ ] T074 Deploy to Vercel preview; manually check each of the 19 routes at 1280 / 1440 / 1920 px viewports. Record screenshot or checklist in PR description for reviewer.
- [ ] T075 Manual accessibility pass — tab through `/admin/members`, `/admin/settings/fees`, `/admin/plans/[year]/[planId]` with keyboard only; confirm focus order unchanged and no trap; confirm `@axe-core/playwright` suite still green (per Spec §FR-010).
- [ ] T076 Manual Thai-locale readability spot check — open `/admin/settings/fees` and `/admin/plans/new` with `locale=th`, confirm Thai text wraps at word boundaries (ICU line-break engaged per Spec §FR-017).

### 7d. Scope-gate verification

- [ ] T077 Per Spec §FR-018, verify the PR diff touches ZERO of: package.json dependencies, `i18n/messages/*.json`, `drizzle/migrations/**`, `src/app/api/**`, `src/modules/**` (except type-only imports for presentation), audit event enum, RBAC policy files, observability metric definitions. Any touch = scope violation to revert.

### 7e. Ready to ship

- [ ] T078 Open PR. Title: `feat(layout): content-type-based width containers (F5)`. Body: link to spec + plan + critique + filled checklist. Request 1 reviewer (standard threshold — no security/RBAC/payment/PII surfaces touched).

---

## Dependencies

```text
Phase 1 (Setup)
    ↓
Phase 2 (Foundational) — primitives + tokens + CI script
    ↓                           ↓                           ↓
Phase 3 (US1 tables)     Phase 4 (US2 forms)         Phase 5 (detail non-regression)
    ↓                           ↓                           ↓
    └───────────────────────────┴───────────────────────────┘
                                ↓
                         Phase 6 (cross-cutting + teardown)
                                ↓
                         Phase 7 (polish + PR)
```

- Phases 3, 4, 5 are **independent** once Phase 2 is done — can run in parallel if multiple people work on it.
- Phase 6d (delete ContentContainer) MUST run AFTER Phase 5 finishes (all pages migrated), otherwise `pnpm typecheck` breaks.

## Parallel execution examples

### Phase 2 primitives (T009–T011)

All three new component files are independent. Run in parallel once their failing tests (T003–T005) are committed RED.

### Phase 3 page migrations (T018–T020)

Three independent files, three parallel edits.

### Phase 4 page migrations (T026–T035)

Ten independent files — edit in parallel.

### Phase 5 page migrations (T047–T052)

Six independent files — edit in parallel.

## Implementation strategy

- **MVP** = Phase 1 + 2 + 3 (T001–T024). Delivers P1 user story "tables stop squeezing" on the 3 most-used admin pages. Could technically ship if the rest of the work slipped — however, leaving ContentContainer partially in use violates Spec §FR-009 (hard-remove), so a true MVP ship still requires Phase 5 and Phase 6d.
- **Incremental delivery**: commit at each phase boundary so `main` stays building and tests stay green.
- **Rollback**: single `git revert` of the PR. No data migrations, no feature flags, no env-var toggles.

## Total task count: 80 (T001–T078 with T043 split into T043a/b/c)

- Setup: 2 (T001–T002)
- Foundational: 14 (T003–T016)
- US1 table pages: 8 (T017–T024)
- US2 form pages: 23 (T025–T045, with T043 expanded to T043a/b/c)
- Detail non-regression: 15 (T046–T060)
- Cross-cutting + teardown: 11 (T061–T071)
- Polish: 7 (T072–T078)

**Post-analyze refinements (2026-04-18)**: C1 (mobile 375px viewport added to T017/T025/T046), C2 (FR-015 overflow-x negative assertion added to T003/T004/T005), A1 (T016 CI target pinned to `CLAUDE.md` reproducer + `.husky/pre-push`), A2 (T043 split into T043a/b/c), I1 (plan.md Project Structure documents incremental `container-widths.spec.ts` build).

## Format validation

- [x] All 78 tasks start with `- [ ] T###`.
- [x] Parallelisable tasks are marked `[P]`.
- [x] User-story tasks carry `[US1]` or `[US2]` labels; non-story phases have no story label per the format rule.
- [x] Every task includes an exact file path (or explicit "if missing, create" instruction).
- [x] Each user story's independent test criterion is stated in its phase header.
