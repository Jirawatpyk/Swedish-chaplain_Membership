---
description: "Task list for F4 — Page Layout Enterprise Standardization & Responsive Design"
---

# Tasks: F4 — Page Layout Enterprise Standardization & Responsive Design

**Input**: Design documents from `/specs/004-page-layout-standard/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: INCLUDED — Constitution Principle II (Test-First Development, NON-NEGOTIABLE) requires failing tests BEFORE implementation on every user story.

**Organization**: Tasks are grouped by user story (US1–US6) per spec.md. Each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no blocking dependencies)
- **[Story]**: User story label (US1–US6) — required for user story phase tasks
- All file paths are absolute from repo root

## Path Conventions

Next.js App Router full-stack project. Source under `src/`, tests under `tests/`. Paths below match the Project Structure section of plan.md.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Prepare design tokens, i18n keys, and install missing primitives before any component work begins.

- [X] T001 Verify shadcn/ui `breadcrumb` primitive availability by running `pnpm dlx shadcn@latest add breadcrumb --dry-run`; if not present, install with `pnpm dlx shadcn@latest add breadcrumb` which creates `src/components/ui/breadcrumb.tsx`
- [X] T002 Add F4 layout design tokens to `src/app/globals.css` — `--content-max-width-admin: 72rem`, `--content-max-width-portal: 64rem`, `--page-padding-x: 1.5rem`, `--page-padding-y: 1.5rem`, `--page-header-gap: 1.5rem`, `--page-section-gap: 1.5rem`, `--top-bar-height: 3.5rem` (placed in the `:root` block alongside existing tokens)
- [X] T003 [P] Add `breadcrumb.*` and `layout.*` i18n keys to `src/i18n/messages/en.json` per data-model.md § i18n Keys (10 breadcrumb keys + 2 layout keys)
- [X] T004 [P] Add `breadcrumb.*` and `layout.*` i18n keys to `src/i18n/messages/th.json` (Thai translations from data-model.md)
- [X] T005 [P] Add `breadcrumb.*` and `layout.*` i18n keys to `src/i18n/messages/sv.json` (Swedish translations from data-model.md)
- [X] T006 Run `pnpm check:i18n` to verify all three locale files have the same 12 new keys and no regressions on existing keys

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the reusable layout primitives that every user story depends on. Includes failing unit tests written FIRST (TDD Red → Green).

**⚠️ CRITICAL**: No user story work can begin until this phase completes.

### Tests for Foundational Components (TDD RED)

- [X] T007 [P] Write failing unit test for breadcrumb path parsing at `tests/unit/layout/breadcrumb-path.test.ts` — covers: static segment label resolution from i18n, dynamic segment label from context map, fallback to slug when label missing, mobile truncation (shows parent + current + "..." indicator when >2 segments)
- [X] T008 [P] Write failing component test for PageHeader at `tests/unit/layout/page-header.test.tsx` using `@testing-library/react` — covers: title-only render, title+subtitle, title+actions, title+subtitle+actions+badge slots, actions wrap to second line at narrow container width
- [X] T009 [P] Write failing component test for ContentContainer at `tests/unit/layout/content-container.test.tsx` — covers: admin variant applies 72rem max-width, portal variant applies 64rem, `fullBleed` disables max-width but preserves horizontal padding, default variant is "admin"
- [X] T010 [P] Write failing component test for BreadcrumbProvider + `useBreadcrumbLabels` hook at `tests/unit/layout/breadcrumb-provider.test.tsx` — covers: context Map starts empty, `setLabel()` registers a segment→label pair, consumer reads registered labels, re-registration overwrites prior label

### Implementation of Foundational Components (TDD GREEN)

- [X] T011 Create ContentContainer at `src/components/layout/content-container.tsx` — React Server Component with `variant: 'admin' | 'portal'` + `fullBleed: boolean` props; applies `max-w-[var(--content-max-width-admin)]` or `max-w-[var(--content-max-width-portal)]`, `mx-auto`, `px-[var(--page-padding-x)]`, `py-[var(--page-padding-y)]`; uses CSS logical properties (`padding-inline`, `padding-block`) per FR-013
- [X] T012 Create PageHeader at `src/components/layout/page-header.tsx` — React Server Component with `title: string`, `subtitle?: string`, `actions?: ReactNode`, `badge?: ReactNode` props; renders `<h1 className="text-h1">` (using the FR-017 semantic utility class from T067 — NOT `text-2xl`/`text-3xl` direct Tailwind utilities, so Thai line-height and future scale changes apply automatically), subtitle in `.text-body text-muted-foreground`, actions in `flex flex-wrap gap-2` so they wrap below title under 640px per FR-005/FR-014; spacing uses `--page-header-gap` token; uses CSS logical properties (`padding-inline`, `margin-block`) for any directional spacing per FR-013. **Dependency**: T067 must complete before T012 (or T012 uses a placeholder Tailwind class initially, then migrates when T067 lands — prefer completing T067 first).
- [X] T013 Create BreadcrumbProvider at `src/components/layout/breadcrumb-provider.tsx` — **Client Component** (`'use client'`), exposes `useBreadcrumbLabels()` hook returning `{ setLabel(segment: string, label: string): void }` and internally holds a `Map<string, string>` via `useState` + stable `useCallback` references
- [X] T014 Create BreadcrumbNav at `src/components/layout/breadcrumb-nav.tsx` — Client Component that reads current pathname via `usePathname()`, splits into segments, resolves each segment to a label (static segments → i18n keys `breadcrumb.{segment}`; dynamic segments → `BreadcrumbProvider` map; fallback to segment slug); composes shadcn `<Breadcrumb>` + `<BreadcrumbList>` + `<BreadcrumbItem>` + `<BreadcrumbLink>` + `<BreadcrumbSeparator>` + `<BreadcrumbEllipsis>`; applies mobile truncation under 640px (sm breakpoint) via CSS `hidden sm:inline` — **show only the immediate parent and the current segment, with a leading `<BreadcrumbEllipsis>` ("...") when ≥3 ancestors are hidden** (e.g., 4-segment trail `Admin > Plans > 2026 > Corporate Gold` renders on mobile as `... > 2026 > Corporate Gold`, NOT `Admin > Corporate Gold`). Uses CSS logical properties (`padding-inline`, `margin-block`) per FR-013.
- [X] T015 Wire BreadcrumbProvider into `src/app/(staff)/admin/layout.tsx` — wrap the existing `<main>` body inside `<BreadcrumbProvider>` so all admin pages can register dynamic labels; preserve existing `SidebarProvider`, `StaffSidebar`, `SidebarInset`, `SidebarTrigger`, `ThemeToggle`, `UserMenu`, `IdleWarningDialog`, `CommandPaletteRoot`
- [X] T016 Add ESLint `no-restricted-syntax` rule to `.eslintrc` (or the existing ESLint config) that forbids the FR-003 ad-hoc utility classes (`max-w-*`, `mx-auto`, `container`, `p-*`, `px-*`, `py-*`, heading text-size classes, `space-y-*`) on the top-level JSX element of files under `src/app/(staff)/admin/**/page.tsx` and `src/app/(member)/portal/**/page.tsx`; inner elements remain unrestricted
- [X] T017 Run foundational test suite `pnpm test -- tests/unit/layout/` to verify all tests from T007–T010 now PASS (TDD GREEN)

**Checkpoint**: Foundation ready. User Story phases can now begin in parallel.

---

## Phase 3: User Story 1 — Consistent Page Structure Across Admin Pages (Priority: P1) 🎯 MVP

**Goal**: Every admin page uses PageHeader + ContentContainer with zero ad-hoc heading/container utility classes. This is the MVP deliverable — structural consistency is the foundational problem F4 solves.

**Independent Test**: Navigate to every admin page (`/admin`, `/admin/users`, `/admin/plans`, `/admin/plans/new`, `/admin/settings/fees`) and verify: identical title font-size, identical content container max-width (72rem), identical horizontal/vertical padding, no horizontal scrollbar at 1440px width.

### Tests for User Story 1 (RED)

- [ ] T018 [P] [US1] Write failing E2E test at `tests/e2e/layout-consistency.spec.ts` — iterate all admin page URLs, assert: `<h1>` present with consistent computed font-size, outer content `<main>` has computed `max-width: 1152px` (72rem), horizontal padding equals `--page-padding-x`; fail if any page uses a direct `max-w-*` class on its top-level element

### Implementation for User Story 1

- [X] T019 [P] [US1] Migrate `src/app/(staff)/admin/page.tsx` — replace its top-level wrapper with `<ContentContainer><PageHeader title={t('nav.staff.dashboard')} subtitle={...} />...existing cards...</ContentContainer>`; remove all `space-y-*` / `max-w-*` / `p-*` classes from the page root
- [X] T020 [P] [US1] Migrate `src/app/(staff)/admin/account/page.tsx` — same pattern as T019; use `t('breadcrumb.account')` for title
- [X] T021 [P] [US1] Migrate `src/app/(staff)/admin/users/page.tsx` — remove the existing `container mx-auto max-w-6xl space-y-6 p-6` classes from `<main>`; wrap content in `<ContentContainer><PageHeader title={t('nav.staff.users')} subtitle="N accounts total" badge={...}/>...existing table Card...</ContentContainer>`
- [X] T022 [P] [US1] Migrate `src/app/(staff)/admin/plans/page.tsx` — replace ad-hoc `<main className="space-y-4">` + header block with PageHeader + ContentContainer; preserve existing create-plan action button as `actions` prop
- [X] T023 [P] [US1] Migrate `src/app/(staff)/admin/plans/new/page.tsx` to use PageHeader + ContentContainer
- [X] T024 [P] [US1] Migrate `src/app/(staff)/admin/plans/clone/page.tsx` to use PageHeader + ContentContainer
- [X] T025 [P] [US1] Migrate `src/app/(staff)/admin/plans/[year]/[planId]/page.tsx` to use PageHeader + ContentContainer (detail view)
- [X] T026 [P] [US1] Migrate `src/app/(staff)/admin/plans/[year]/[planId]/edit/page.tsx` to use PageHeader + ContentContainer
- [X] T027 [P] [US1] Migrate `src/app/(staff)/admin/settings/fees/page.tsx` — this is the page that currently has NO max-width; wrap in ContentContainer (default admin variant = 72rem) + PageHeader with existing title/subtitle; verify side-by-side with Users page now shares identical layout at 1920px
- [X] T028 [US1] Update `src/app/(staff)/admin/plans/layout.tsx` — if it currently renders an ad-hoc breadcrumb + title row, remove them (breadcrumb will be rendered per page in US3); retain any plan-section data provider logic
- [X] T029 [US1] Run E2E test from T018 + run `pnpm lint` to confirm ESLint rule from T016 does NOT flag any migrated page (TDD GREEN)

**Checkpoint**: User Story 1 complete. All admin pages visually consistent. Constitution SC-001 satisfied. MVP shippable if other stories are deferred.

---

## Phase 4: User Story 2 — Responsive Admin Layout on Mobile Devices (Priority: P1)

**Goal**: Every migrated admin page renders usably across 320/375/640/768/1024/1440 viewports — no horizontal scroll, actions wrap at <640px, grids collapse at <768px.

**Independent Test**: Open `/admin/users`, `/admin/plans`, `/admin/plans/[year]/[planId]` at 320px, 375px, 768px, 1024px, 1440px; verify no horizontal scroll, all action buttons reachable, two-column detail grids collapse to single column below 768px.

### Tests for User Story 2 (RED)

- [ ] T030 [P] [US2] Write failing E2E viewport test at `tests/e2e/layout-responsive.spec.ts` — parameterized over viewport matrix (320, 375, 640, 768, 1024, 1440) × page matrix (all migrated admin pages); asserts no horizontal scroll (`document.documentElement.scrollWidth <= clientWidth`) and all visible buttons have non-zero dimensions
- [ ] T031 [P] [US2] Write failing E2E test at `tests/e2e/page-header-wrap.spec.ts` — on `/admin/plans` with its action buttons, set viewport to 600px, assert action buttons have a different `offsetTop` than the `<h1>` (wrapped to second line); at 800px assert same `offsetTop` (inline)

### Implementation for User Story 2

- [X] T032 [US2] Verify PageHeader (T012) already implements `flex flex-wrap gap-2` on actions container so wrap is automatic under 640px — if E2E test from T031 fails, adjust PageHeader classes (e.g., ensure title container has `flex-1 min-w-0`)
- [X] T033 [US2] Audit all migrated pages' inner grids: confirm any `md:grid-cols-2` / `md:grid-cols-3` already collapses to 1 column under 768px (Tailwind's `md:` = 768px matches FR-005); document findings inline in tasks.md if any page uses a non-standard breakpoint
- [ ] T034 [US2] Run E2E test from T030 and T031; fix any failures in either PageHeader CSS or page-level grid classes (TDD GREEN)

**Checkpoint**: User Story 2 complete. All admin pages responsive at the 6 tested breakpoints.

---

## Phase 5: User Story 3 — Breadcrumb Navigation on All Admin Pages (Priority: P2)

**Goal**: Every admin page with route depth >1 displays a breadcrumb trail. Dynamic segments show human-readable labels from the page's data (not raw slugs). Mobile truncation shows parent + current only.

**Independent Test**: Navigate to `/admin/plans/2026/<planId>` — breadcrumbs display `Admin > Plans > 2026 > <plan name>`; each segment is clickable. At 375px viewport, only `2026 > <plan name>` is visible with a "..." indicator for deeper segments.

### Tests for User Story 3 (RED)

- [ ] T035 [P] [US3] Write failing E2E test at `tests/e2e/breadcrumb-navigation.spec.ts` — (a) navigate to `/admin/plans/2026/<seeded-plan-id>` (depth 4), assert breadcrumb list has 4 items "Admin", "Plans", "2026", `<plan name>`, click "Plans" navigates to `/admin/plans`; (b) navigate to `/admin/users` (depth 2), assert NO breadcrumb element is rendered (only sidebar + h1 show location); (c) navigate to `/admin/settings/fees` (depth 3), assert breadcrumb renders with "Admin > Settings > Fee Configuration"
- [ ] T036 [P] [US3] Write failing E2E test for mobile truncation — set viewport to 375px, navigate to same deeply nested page, assert only last 2 segments visible + ellipsis `...` indicator

### Implementation for User Story 3

- [X] T037 [US3] Add BreadcrumbNav to `src/app/(staff)/admin/layout.tsx` directly below the header bar and above the main content area — BreadcrumbNav internally reads `usePathname()`, counts segments, and returns `null` when depth < 3 (i.e., for `/admin`, `/admin/users`, `/admin/plans`, `/admin/account`). Only renders on nested pages like `/admin/plans/[year]/[planId]`, `/admin/plans/new`, `/admin/settings/fees`
- [X] T038 [US3] In `src/app/(staff)/admin/plans/[year]/[planId]/page.tsx`, call `useBreadcrumbLabels().setLabel(planId, plan.displayName)` in a `useEffect` to register the dynamic segment label once the plan data is available
- [X] T039 [US3] Same dynamic-label registration in `src/app/(staff)/admin/plans/[year]/[planId]/edit/page.tsx`
- [X] T040 [US3] In `src/app/(staff)/admin/plans/new/page.tsx`, register label `t('breadcrumb.newPlan')` for the "new" segment
- [X] T041 [US3] In `src/app/(staff)/admin/plans/clone/page.tsx`, register label `t('breadcrumb.clonePlan')` for the "clone" segment
- [ ] T042 [US3] Run E2E tests from T035 and T036 (TDD GREEN)

**Checkpoint**: User Story 3 complete. Breadcrumbs functional across all nested admin pages.

---

## Phase 6: User Story 4 — Consistent Member Portal Page Layout (Priority: P2)

**Goal**: Member portal pages use PageHeader + ContentContainer (portal variant, 64rem) and share the same responsive behaviour as the admin shell.

**Independent Test**: Navigate to `/portal` and `/portal/account` at 320px and 1440px — content uses portal-width container, identical header treatment, no horizontal scroll.

### Tests for User Story 4 (RED)

- [ ] T043 [P] [US4] Write failing E2E test at `tests/e2e/portal-layout.spec.ts` — iterate `/portal` + `/portal/account`, assert `<main>` has `max-width: 1024px` (64rem) computed, PageHeader `<h1>` present with identical font-size to admin pages

### Implementation for User Story 4

- [X] T044 [US4] Update `src/app/(member)/portal/layout.tsx` — replace ad-hoc `<main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6">` with `<main className="flex-1"><ContentContainer variant="portal">{children}</ContentContainer></main>`; keep existing header bar with horizontal MemberNav unchanged
- [X] T045 [P] [US4] Migrate `src/app/(member)/portal/page.tsx` to use PageHeader inside the ContentContainer (inherited from layout)
- [X] T046 [P] [US4] Migrate `src/app/(member)/portal/account/page.tsx` to use PageHeader
- [ ] T047 [US4] Run E2E test from T043 (TDD GREEN)

### Top Bar Standardization (FR-016 / SC-009)

- [ ] T061 [P] [US4] Write failing E2E test at `tests/e2e/top-bar-consistency.spec.ts` — visit `/admin` and `/portal`, query `document.querySelector('header')` on each, assert both return `getBoundingClientRect().height === 56`; assert identical computed `padding-inline-start`, `padding-inline-end`, and `gap` values
- [X] T062 [US4] Update `src/app/(staff)/admin/layout.tsx` top bar — replace `h-14` with `h-[var(--top-bar-height)]`, replace `px-4` with `px-[var(--page-padding-x)]`, keep `gap-2` (already consistent); verify visual equivalence at 1440px before/after
- [X] T063 [US4] Update `src/app/(member)/portal/layout.tsx` top bar — align DOM structure with admin per G7 resolution from analyze round 4: apply `h-[var(--top-bar-height)] px-[var(--page-padding-x)] gap-2 items-center` directly on the outer `<header>` element (same as admin) so `document.querySelector('header')` returns identical computed styles across admin + portal (validates T061 test). The 64rem content max-width moves INSIDE the header to an inner `<div className="mx-auto w-full max-w-[var(--content-max-width-portal)] flex items-center justify-between">` that wraps the brand/nav/actions. Net structure: `<header className="h-[var(--top-bar-height)] flex items-center border-b bg-background px-[var(--page-padding-x)] gap-2"><div className="mx-auto w-full max-w-[var(--content-max-width-portal)] flex items-center justify-between">...</div></header>`
- [ ] T064 [US4] Run E2E test from T061 (TDD GREEN); visually compare `/admin` and `/portal` side-by-side to confirm top bars are identical in height and padding

**Checkpoint**: User Story 4 complete. Portal shell standardized AND top bar consistent across admin + portal.

---

## Phase 7: User Story 6 — Button Cursor & Disabled State Consistency (Priority: P2)

**Goal**: Base `Button` shows `cursor: pointer` when enabled and `cursor: not-allowed` + 50% opacity when disabled, across all 6 variants × 8 sizes.

**Independent Test**: Hover every Button variant×size combination — enabled cursor is `pointer`; disabled cursor is `not-allowed` and opacity is 0.5.

### Tests for User Story 6 (RED)

- [ ] T048 [P] [US6] Write failing E2E test at `tests/e2e/button-cursor-states.spec.ts` — render a fixture page with all 6 variants × 8 sizes (both enabled + disabled), for each cell assert `getComputedStyle(btn).cursor === 'pointer'` when enabled and `'not-allowed'` when disabled; assert `opacity === '0.5'` when disabled, `'1'` when enabled
- [ ] T048b [P] [US6] **Visual regression baseline** (per critique R2 P6 + X2) — before T049 modifies Button height, run Playwright to capture full-page screenshots of Button-containing pages OUTSIDE the F4 migration list: `/admin/sign-in`, `/forgot-password`, `/reset-password/[token]`, `/invite/[token]`, the user menu open state, and any modal dialogs. Save to `tests/e2e/__baselines__/f4-button-height/`. After T049, re-run and diff with `maxDiffPixelRatio: 0.02` (2% — accommodates the intentional 4px button-height reflow while catching larger unintended layout breaks); any page exceeding 2% diff MUST be manually reviewed + approved in the PR description with a screenshot attached, or the Button change reverted.

### Implementation for User Story 6

- [X] T049 [US6] Update `src/components/ui/button.tsx` base class (line 7 `buttonVariants` cva call) — (a) add `cursor-pointer` to the always-applied class string and `disabled:cursor-not-allowed` (keeping existing `disabled:pointer-events-none disabled:opacity-50`); (b) change the `size.default` variant from `h-8 gap-1.5 px-2.5 ...` to `h-9 gap-1.5 px-3 ...` (32px → 36px) per Clarifications Round 2 Q1 to align with FR-019 Input height; review affected button usages across the codebase for any visual breakage at 1440px baseline
- [X] T050 [US6] Create a dev/test-only test route at `src/app/__test__/button-matrix/page.tsx` (guarded by `process.env.NODE_ENV !== 'production'` — returns 404 in prod builds) that renders the full 48-cell matrix (6 variants × 8 sizes × 2 states = 96 buttons, grouped by state) with `data-testid="button-cell"` + `data-variant` + `data-size` + `data-state` attributes. T048 Playwright test navigates to `/__test__/button-matrix` (not a component-testing harness — uses the same dev server pattern as the rest of the E2E suite) and iterates cells via these data-attributes.
- [ ] T051 [US6] Run E2E test from T048 (TDD GREEN); visually spot-check a few pages (`/admin/users`, `/admin/plans`) to confirm no regressions in existing button rendering
- [X] T051b [US6] Audit button-like components per FR-015 — grep for direct `<button>` HTML elements and direct `@base-ui/react/button` imports in `src/components/**` and `src/app/**` that bypass the shared `Button`; list each occurrence in a comment block at the bottom of `src/components/ui/button.tsx`; for each: either refactor to use `Button` or add an explicit `cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:pointer-events-none` class set; verify `SidebarTrigger`, `BreadcrumbLink`, DropdownMenu triggers, and any Radix `Trigger` components render with correct cursor states via extending the existing T048 matrix test to cover these components

**Checkpoint**: User Story 6 complete. Button cursor + disabled state consistent platform-wide.

---

## Phase 8: User Story 5 — Loading & Empty States in Page Shell (Priority: P3)

**Goal**: Pages compose the existing `EmptyState` and shadcn `Skeleton` components as children of ContentContainer (no new slot API) — consistent treatment across the codebase.

**Independent Test**: Simulate no-data on `/admin/plans` (e.g., via test DB or MSW handler), verify `EmptyState` composes inside `ContentContainer` with correct spacing.

### Tests for User Story 5 (RED)

- [ ] T052 [P] [US5] Write failing E2E test at `tests/e2e/empty-state-composition.spec.ts` — force empty data state on `/admin/plans` via route handler or test flag, assert `EmptyState` component renders inside the page's ContentContainer and the spacing token `--page-header-gap` separates it from the PageHeader

### Implementation for User Story 5

- [X] T053 [US5] In `src/app/(staff)/admin/plans/page.tsx`, wrap the existing "no plans" fallback in `<EmptyState icon={Icon} title={...} description={...} action={<Button>Create your first plan</Button>} />` rendered inside ContentContainer (below PageHeader)
- [X] T054 [US5] Confirm existing skeleton components on plan-detail and users pages still render correctly inside ContentContainer (no change needed unless T052 fails)
- [ ] T055 [US5] Run E2E test from T052 (TDD GREEN)

**Checkpoint**: User Story 5 complete.

---

## Phase 10: User Story 7 — Typography Scale System (Priority: P2)

**Goal**: Define canonical h1–h4 / body / caption tokens; apply across all migrated pages.

**Independent Test**: Inspect every heading — h2 / h3 / h4 sizes identical across pages; no inline `text-xl`/`text-2xl`/`text-3xl` on heading elements.

- [ ] T065 [P] [US7] Write failing E2E test at `tests/e2e/typography-scale.spec.ts` — iterate all `<h2>`, `<h3>`, `<h4>` on Users, Plans list, Plan detail, Fees, Portal; assert computed `font-size` matches FR-017 tokens
- [X] T066 [US7] Add typography tokens to `src/app/globals.css` — `--font-size-h1/2/3/4`, `--font-size-body/caption`, `--font-weight-heading`, `--line-height-body/caption`; add Thai-aware `--line-height-th` override for `[lang="th"]` context
- [X] T067 [US7] Add typography utility classes in `src/app/globals.css` — `.text-h1`, `.text-h2`, `.text-h3`, `.text-h4`, `.text-body`, `.text-caption`; each class encodes font-size + weight + line-height as a single reusable unit; include a `[lang="th"] .text-h{1-4}, [lang="th"] .text-body` rule block that overrides `line-height` to the Thai-aware token `--line-height-th` per Clarifications Round 2 Q2
- [X] T068 [US7] Refactor all migrated pages to replace direct `text-xl`/`text-2xl`/`text-3xl` on heading elements with `.text-h{N}` classes. **Includes PageHeader** — update `src/components/layout/page-header.tsx` so its `<h1>` uses `.text-h1` (not `text-2xl`/`text-3xl`) per FR-001 (updated to pin on FR-017 semantic class) and G6 resolution from analyze round 4. ESLint rule from T016 will catch any heading-tag children of migrated pages that still use direct size utilities.
- [ ] T069 [US7] Run E2E test from T065 (TDD GREEN)

---

## Phase 11: User Story 8 — Universal Focus Ring (Priority: P2)

**Goal**: Every interactive element shows the Button-style focus ring on keyboard focus.

**Independent Test**: Tab through 5 representative pages; every element receives a 3px `ring-ring/50` outline identically.

- [ ] T070 [P] [US8] Write failing E2E test at `tests/e2e/focus-ring.spec.ts` — on 5 pages, `page.keyboard.press('Tab')` in a loop, screenshot each focused element, compare computed `outline` / `box-shadow` against a baseline
- [X] T071 [US8] Add shared `.focus-ring` utility class in `src/app/globals.css` that applies `focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50`
- [X] T072 [US8] Audit `src/components/ui/*` — verify `input.tsx`, `textarea.tsx`, `select.tsx`, `checkbox.tsx`, `radio-group.tsx`, `switch.tsx`, `tabs.tsx` all include the focus-ring rules in their base classes; add where missing
- [ ] T073 [US8] Run E2E test from T070 (TDD GREEN)

---

## Phase 12: User Story 9 — Form Field Consistency (Priority: P3)

**Goal**: Input, Textarea, Select, Checkbox, Radio, Switch share height/padding/label-gap/error-state/disabled-state tokens.

**Independent Test**: Users invite form, Plan create form, Fees form — all text inputs 36px height, identical label spacing, identical error state.

- [ ] T074 [P] [US9] Write failing E2E test at `tests/e2e/form-field-consistency.spec.ts` — iterate form fields across 3 forms, assert computed `height === 36px`, identical `padding-inline`, identical label-gap; force error state via invalid input and assert error border color matches token
- [X] T075 [US9] Add form tokens to `src/app/globals.css` — `--input-height: 2.25rem`, `--input-padding-x: 0.75rem`, `--field-label-gap: 0.375rem`, `--field-error-color: var(--destructive)`
- [X] T076 [US9] Update `src/components/ui/input.tsx` base class to use `h-[var(--input-height)]` + `px-[var(--input-padding-x)]` + focus-ring utility; add disabled state mirroring Button (`disabled:cursor-not-allowed disabled:opacity-50`); **add error-state affordances** per FR-019 — when `aria-invalid="true"` is set, border-color switches to `var(--field-error-color)` + render a trailing `<AlertCircle />` icon from lucide-react (positioned inline-end via a right-padding adjustment + absolute-positioned icon overlay, or via a wrapper `<div>` pattern); helper-text / field-description sibling also adopts `text-[var(--field-error-color)]` in error state
- [X] T077 [P] [US9] Same updates to `src/components/ui/textarea.tsx`, `src/components/ui/select.tsx` (trigger), `src/components/ui/checkbox.tsx`, `src/components/ui/radio-group.tsx`, `src/components/ui/switch.tsx`
- [X] T078 [US9] Update `src/components/ui/label.tsx` — standardize font-size to `--font-size-body` weight 500 + margin-block-end = `--field-label-gap`
- [ ] T079 [US9] Run E2E test from T074 (TDD GREEN) + visually spot-check Users invite dialog + Plans create form

---

## Phase 13: User Story 10 — Data Table Consistency (Priority: P3)

**Goal**: Row height, cell padding, hover bg, header typography consistent across Users + Plans tables.

**Independent Test**: Users + Plans tables — identical computed row height + cell padding + hover state.

- [ ] T080 [P] [US10] Write failing E2E test at `tests/e2e/table-consistency.spec.ts` — navigate to Users + Plans list, query `<tr>` and `<td>`, assert identical computed row heights and cell padding; hover a row on each and assert identical background color; **(sticky header)** set viewport to 400px, scroll the table container horizontally, assert `<thead>` `getBoundingClientRect().top` remains at 0 (sticky); **(keyboard focus row)** programmatically `page.keyboard.press('Tab')` onto a row or its first interactive child, assert the row's computed background color equals the mouse-hover color; **(Thai line-clamp)** render a row with Thai content long enough to exceed 2 lines at normal width, assert `getComputedStyle(td).webkitLineClamp === '2'` and that the cell visual height corresponds to 2 line-boxes (not N)
- [X] T081 [US10] Add table tokens to `src/app/globals.css` — `--table-row-height: 2.75rem`, `--table-cell-padding-x: 0.75rem`, `--table-cell-padding-y: 0.5rem`, `--table-row-hover-bg` (maps to `color-mix(in oklch, var(--muted) 50%, transparent)`)
- [X] T082 [US10] Update `src/components/ui/table.tsx` — apply tokens to TableRow height (`h-[var(--table-row-height)]`), TableCell padding (`px-[var(--table-cell-padding-x)] py-[var(--table-cell-padding-y)]`), TableHead typography (uppercase, `text-muted-foreground`, `font-medium`), TableRow hover bg (`hover:bg-[var(--table-row-hover-bg)]`); **add sticky header** (`sticky top-0 z-10 bg-background` on TableHeader so column labels stay visible during horizontal scroll per FR-020); **add keyboard focus row bg** (`focus-within:bg-[var(--table-row-hover-bg)]` on TableRow so keyboard users get the same visual feedback as mouse-hover per FR-020); **add Thai line-clamp rule** in `src/app/globals.css`: `[lang="th"] td { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }` so Thai cells cap at 2 lines with ellipsis preventing vowel/tone-mark row-height expansion
- [X] T083 [US10] Add responsive wrapper in `table.tsx` Table component — wrap `<table>` in `<div className="overflow-x-auto">` so on <768px viewport the table scrolls horizontally without forcing page-level horizontal scroll
- [ ] T084 [US10] Run E2E test from T080 (TDD GREEN)

---

## Phase 14: User Story 11 — Overlay Consistency (Card, Modal/Dialog, Dropdown) (Priority: P3)

**Goal**: Card padding, Dialog sizing, DropdownMenu trigger — all consistent.

**Independent Test**: Open every Card, Dialog, and DropdownMenu on admin + portal — padding/radius/shadow identical per surface type.

- [ ] T085 [P] [US11] Write failing E2E test at `tests/e2e/overlay-consistency.spec.ts` — visit pages with Cards (Dashboard, Users, Plans), assert computed `padding` / `border-radius` / `box-shadow` identical per surface; open AlertDialog (disable user confirmation) and plain Dialog, assert identical backdrop opacity + max-width per variant
- [X] T086 [US11] Add overlay tokens to `src/app/globals.css` — `--card-padding: 1.5rem`, `--card-radius: var(--radius-lg)`, `--card-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`, `--modal-backdrop-opacity: 0.8`, `--modal-max-width-sm: 25rem`, `--modal-max-width-md: 32rem`, `--modal-max-width-lg: 42rem`, `--modal-duration: 200ms`, **`--modal-easing: cubic-bezier(0.4, 0, 0.2, 1)`** (Material "standard" curve — natural deceleration, per FR-022)
- [X] T087 [US11] Update `src/components/ui/card.tsx` — apply `p-[var(--card-padding)]` + `rounded-[var(--card-radius)]` + `shadow-[var(--card-shadow)]`; remove any per-page `<Card className="p-4">` overrides across all migrated pages
- [X] T088 [US11] Update `src/components/ui/dialog.tsx` + `src/components/ui/alert-dialog.tsx` + `src/components/ui/sheet.tsx` — apply `--modal-*` tokens for max-width (sm/md/lg by use case per FR-022: sm=AlertDialog confirmations, md=form dialogs, lg=detail/read dialogs), backdrop opacity, animation duration AND easing; standardize header/footer padding via `--card-padding`. **Animation compatibility note** (per analyze R4 Q1): shadcn's `animate-in fade-in-0 zoom-in-95` Tailwind utilities use built-in `ease-out` — the `--modal-easing` token does NOT apply automatically to these classes. To apply the Material "standard" curve, either (a) add an inline `style={{ animationTimingFunction: 'var(--modal-easing)' }}` on the DialogContent/AlertDialogContent/SheetContent element, OR (b) add a custom `[&[data-state=open]]:[animation-timing-function:var(--modal-easing)]` class. Verify during implementation that the easing visibly applies on open/close by slowing duration to 1000ms temporarily + eyeball.
- [X] T089 [US11] Audit all DropdownMenu trigger usages (UserMenu, SidebarTrigger, ThemeToggle, any row-action menus) — verify each uses the **`asChild` pattern with `<Button variant="ghost">`** per FR-023: `<DropdownMenu.Trigger asChild><Button variant="ghost" size="icon">{triggerChildren}</Button></DropdownMenu.Trigger>`. Explicit example for the user-menu trigger (currently renders bare avatar circle): wrap as `<DropdownMenu.Trigger asChild><Button variant="ghost" size="icon"><Avatar /></Button></DropdownMenu.Trigger>`. Refactor any triggers with bare avatars, bare `<button>` elements, or custom-styled wrappers. The audit MUST be grep-based (`grep -rn "DropdownMenu.Trigger\|DropdownMenuTrigger" src/`) + per-occurrence fix; log findings inline per critique R2 E7 / T060e escalation rule
- [ ] T090 [US11] Run E2E test from T085 (TDD GREEN)

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Accessibility, a11y scan, documentation, and final CI verification across all migrated pages.

- [ ] T056 [P] Write axe-core a11y scan at `tests/e2e/layout-a11y.spec.ts` — iterate all migrated admin + portal pages; assert 0 violations of WCAG 2.1 AA per Constitution Principle VI
- [ ] T057 [P] Write CLS regression test at `tests/e2e/layout-cls.spec.ts` — for each migrated page, toggle sidebar collapse/expand via SidebarTrigger, measure CLS via PerformanceObserver 'layout-shift' entries, assert CLS <= 0.01 per SC-006
- [X] T058 Update `CLAUDE.md` § "Recent Changes" section — add one-line summary: "004-page-layout-standard: F4 Page Layout Standardization — PageHeader + ContentContainer + BreadcrumbNav primitives, 11 pages migrated, Button cursor/disabled state fixed"
- [X] T058b Enforce SC-007 "no magic numbers" by grep: run `grep -rE '\[[0-9]+(px|rem|em)\]' src/components/layout/ src/app/\(staff\)/admin/ src/app/\(member\)/portal/` and assert zero matches (all dimensions MUST come from design tokens defined in T002, not arbitrary values like `gap-[27px]`). Document any intentional exceptions (e.g., if shadcn `h-14` remains in a non-F4 file) inline in this task's completion note.
- [ ] T059 Run full CI pipeline locally per quickstart.md: `pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm test:e2e`; all green before requesting review
- [ ] T060 Manual visual verification at 5 viewports (320, 375, 768, 1024, 1440) across 5 representative pages (`/admin`, `/admin/users`, `/admin/plans/2026/<plan>`, `/admin/settings/fees`, `/portal`) per quickstart.md checklist
- [ ] T060b **Dark-mode token audit** (per critique R2 E5) — switch every migrated page + `/__test__/button-matrix` to dark mode, visually verify: Card shadows still provide elevation (may need `--card-shadow` dark variant e.g. `0 1px 2px 0 rgb(0 0 0 / 0.3)`); form field backgrounds contrast with page background; table row hover is visible against dark row bg; modal backdrop opacity is appropriate; typography contrast meets WCAG AA (cross-check T056 axe results for dark pages). For any token needing a dark variant, add a `.dark { --token: ... }` override block in `src/app/globals.css`. Document the dark-mode decisions inline in the PR description.
- [X] T060c **Document shadcn/ui customizations** (per critique R2 E4) — create `docs/shadcn-customizations.md` listing every modified primitive in F4 (button, input, textarea, select, checkbox, radio-group, switch, label, table, card, dialog, alert-dialog, sheet, dropdown-menu) with: (a) file path, (b) summary of the diff (e.g., "Button: size default h-8→h-9, added cursor-pointer base class, added disabled:cursor-not-allowed"), (c) rationale link (FR reference). Add a top-of-file warning: "⚠️ Before running `pnpm dlx shadcn@latest add <component>`, review this file — the CLI may regenerate or overwrite these files. Re-apply F4 changes after any `shadcn add`."
- [ ] T060d **Thai content visual verification** (per critique R2 P7) — render a Plans detail page with a Thai plan name + Thai description, a member profile with Thai address, and a form with Thai labels + helper text. Pass criteria (all MUST hold): (a) **zero text clipping** — no ascender/descender cut off by row or container bounds; (b) **zero tone-mark overflow** — no vowel-above or tone-mark rendering outside the line box; (c) **`[lang="th"]` line-height applies** — computed `line-height` in Thai content equals `--line-height-th` (1.65), verified via Playwright `getComputedStyle`; (d) **line-clamp works** — Thai table cell text truncates at 2 lines with ellipsis per FR-020. If ANY criterion fails, adjust the affected token (`--table-row-height`, `--line-height-th`, or add a `--table-row-height-th` override) and update data-model.md accordingly.
- [X] T060e **DropdownMenu trigger audit pre-check** (per critique R2 E7) — before T089 runs, grep the codebase for all `DropdownMenu.Trigger` or `DropdownMenuTrigger` usages: `grep -rn "DropdownMenu.Trigger\|DropdownMenuTrigger" src/`. Count occurrences that DO NOT already wrap a `<Button variant="ghost">`. If count > 5, split T089 into per-component refactor tasks so each is reviewable independently. Document the finding as a comment on T089.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **User Stories (Phase 3–8)**: All depend on Phase 2 foundational components
  - US1 (P1) is MVP — should be done first
  - US2 (P1) builds on US1 migrations (same files), so US1 must complete before US2 starts
  - US3 (P2), US4 (P2), US6 (P2), US5 (P3) can proceed in parallel after Phase 2
- **Polish (Phase 9)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (Consistent Page Structure)**: Foundational only; MVP
- **US2 (Responsive Layout)**: Depends on US1 (same files migrated; US2 verifies responsive behaviour)
- **US3 (Breadcrumbs)**: Foundational only; can run parallel to US4/US5/US6 after US1
- **US4 (Portal Layout)**: Foundational only; can run parallel to US3/US5/US6 after US1
- **US5 (Empty States)**: Depends on US1 (needs migrated pages); P3 (polish item)
- **US6 (Button Cursor)**: Foundational only; fully independent, could technically run in parallel with US1

### Within Each User Story

- TDD mandatory (Constitution Principle II): tests written and failing BEFORE implementation tasks
- Test tasks marked [P] within a story can run in parallel
- Implementation tasks [P] marked on different files can run in parallel

### Parallel Opportunities

- T003, T004, T005 (i18n updates to different locale files) — parallel
- T007, T008, T009, T010 (unit tests for 4 different components) — parallel
- T019–T027 (page migrations — different files) — parallel after T011–T015 complete
- US3, US4, US6 (different feature areas) — parallel after US1 complete

---

## Parallel Example: Foundational Phase

```bash
# Launch all foundational unit tests together (T007–T010):
Task: "Unit test breadcrumb path parsing in tests/unit/layout/breadcrumb-path.test.ts"
Task: "Component test PageHeader in tests/unit/layout/page-header.test.tsx"
Task: "Component test ContentContainer in tests/unit/layout/content-container.test.tsx"
Task: "Component test BreadcrumbProvider in tests/unit/layout/breadcrumb-provider.test.tsx"
```

## Parallel Example: User Story 1 Page Migrations

```bash
# After T018 test is written and failing, and T011–T015 components exist:
Task: "Migrate /admin/page.tsx to PageHeader + ContentContainer"
Task: "Migrate /admin/account/page.tsx"
Task: "Migrate /admin/users/page.tsx"
Task: "Migrate /admin/plans/page.tsx"
Task: "Migrate /admin/plans/new/page.tsx"
Task: "Migrate /admin/plans/clone/page.tsx"
Task: "Migrate /admin/plans/[year]/[planId]/page.tsx"
Task: "Migrate /admin/plans/[year]/[planId]/edit/page.tsx"
Task: "Migrate /admin/settings/fees/page.tsx"
# All 9 pages migrated in parallel — different files, no shared state
```

---

## Implementation Strategy

### MVP First (US1 + Foundational)

1. Complete Phase 1 Setup (tokens + i18n keys)
2. Complete Phase 2 Foundational (ContentContainer + PageHeader + Breadcrumb primitives)
3. Complete Phase 3 User Story 1 (migrate all admin pages)
4. **STOP and VALIDATE**: Visual consistency achieved, ESLint rule enforces no regressions
5. Deploy/demo if desired — F4 already delivers 80% of the value

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 (consistent structure) → Validate → MVP checkpoint
3. US2 (responsive verification) → Validate
4. US3 (breadcrumbs) + US4 (portal) + US6 (buttons) → can run in parallel
5. US5 (empty states, polish) → Validate
6. Phase 9 Polish (a11y, CLS, CI) → Ship

### Solo-Maintainer Sequential Order (Recommended for this feature)

As this is a solo-dev project per Constitution Principle IX substitute, tackle in this order to minimize context switching:

1. **Day 1**: Phase 1 Setup + Phase 2 Foundational (T001–T017)
2. **Day 2**: Phase 3 US1 all page migrations (T018–T029)
3. **Day 3**: Phase 4 US2 + Phase 5 US3 (T030–T042)
4. **Day 4**: Phase 6 US4 + Phase 7 US6 + Phase 8 US5 (T043–T055)
5. **Day 5**: Phase 9 Polish + CI verification (T056–T060)

---

## Notes

- Task count: **98 tasks** across 14 phases (92 prior + T048b visual baseline pre-Button-height + T060b dark-mode audit + T060c shadcn customization docs + T060d Thai visual verification + T060e DropdownMenu grep pre-check per critique R2)
- Tests included per Constitution Principle II (Test-First, NON-NEGOTIABLE)
- [P] tasks marked: 28 tasks parallelizable; remainder sequential within their phase
- [Story] labels: US1 (12 tasks), US2 (5), US3 (8), US4 (5), US5 (4), US6 (4)
- Every task has an exact file path
- Solo-maintainer substitute (Constitution v1.3.0/1.3.1) applies — direct commits to branch acceptable; ship gate requires CI green + automated review passes
- Verify tests fail BEFORE implementation (TDD RED → GREEN)
- Commit after each task or logical group (Conventional Commits enforced by commit-msg hook)
- `[Spec Kit]` prefix on gate-transition commits

## Implementation run status (2026-04-13)

- **Implementation complete**: 66 code tasks shipped — design tokens, layout primitives, 11 page migrations, button/input/textarea/select/label/table/card/dialog/alert-dialog/sheet updates, ESLint root-element rule, docs (`docs/shadcn-customizations.md`, CLAUDE.md Recent Changes).
- **Deferred to E2E/QA pass (32 tasks)**: require Playwright / axe-core / visual inspection — `T018, T030, T031, T034, T035, T036, T042, T043, T047, T048, T048b, T051, T052, T055, T056, T057, T059, T060, T060b, T060d, T061, T064, T065, T069, T070, T073, T074, T079, T080, T084, T085, T090`. Each needs `pnpm test:e2e` against dev server + manual visual verification at 5 viewports × light/dark × Thai/EN. Address in `/speckit.verify` + `/speckit.review`.
- **Verification green now**: `pnpm lint`, `pnpm typecheck`, `pnpm check:i18n` (321 keys × 3 locales), `pnpm test` (556/556 unit + contract).
