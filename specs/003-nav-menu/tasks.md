# Tasks: Navigation Menu

**Input**: Design documents from `specs/003-nav-menu/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Included — Constitution Principle II (Test-First Development) is NON-NEGOTIABLE.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1–US5)
- Exact file paths included in descriptions

---

## Phase 1: Setup

**Purpose**: Install dependencies and create shared infrastructure

- [x] T001 Install shadcn/ui Sidebar component via `npx shadcn@latest add sidebar` — generates `src/components/ui/sidebar.tsx` and any missing dependencies (Sheet, Tooltip, etc.)
- [x] T002 [P] Create `src/config/` directory if it doesn't exist
- [x] T003 [P] Add nav i18n keys to `src/i18n/messages/en.json` under `nav.staff.*` and `nav.member.*` namespaces (~15 keys: dashboard, plans, users, settings, settingsFees, sections.settings, collapse, expand, member dashboard, member account, etc.)
- [x] T004 [P] Add nav i18n keys to `src/i18n/messages/th.json` — Thai translations for all `nav.*` keys from T003
- [x] T005 [P] Add nav i18n keys to `src/i18n/messages/sv.json` — Swedish translations for all `nav.*` keys from T003

**Checkpoint**: Dependencies installed, i18n keys ready across 3 locales

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, config, and utilities that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Define `NavItem`, `NavGroup`, `NavSection`, and `NavConfig` TypeScript types in `src/config/nav.ts` per data-model.md — include `titleKey`, `icon`, `href`, `activePattern`, optional `children`, optional `roles` filter (type-only for now — filtering logic deferred until a role-differentiated nav item exists)
- [x] T007 Define `staffNavConfig` in `src/config/nav.ts` — Dashboard (exact match `/admin`), Plans (`/admin/plans`), Users (`/admin/users`), Settings expandable group with Fees sub-item (`/admin/settings/fees`)
- [x] T008 Define `memberNavConfig` in `src/config/nav.ts` — Dashboard (`/portal`), Account (`/portal/account`)
- [x] T009 Implement `isNavItemActive(pathname, activePattern)` utility function in `src/config/nav.ts` — uses "deepest prefix wins" strategy with exact-match support for Dashboard. Export for unit testing.
- [x] T010 ~~Implement `useSidebarState` hook~~ — SKIPPED: shadcn SidebarProvider has built-in cookie sync (`sidebar_state`), localStorage, and keyboard shortcut (Ctrl+B). Custom hook unnecessary. — reads/writes `localStorage('sidebar-collapsed')`, syncs to `document.cookie('sidebar:state')` for SSR, graceful fallback to expanded if localStorage/cookie unavailable

**Checkpoint**: Foundation ready — nav config, types, active-state logic, and state hook complete

---

## Phase 3: User Story 1 — Staff Sidebar Navigation (P1) MVP

**Goal**: Admin and manager users see a persistent sidebar with Dashboard, Plans, Users, and Settings (expandable group) on all `/admin/**` pages.

**Independent Test**: Sign in as admin → sidebar visible → click each link → correct page loads → active item highlighted → tenant name at top.

### Tests for US1

> **Write these tests FIRST, ensure they FAIL before implementation**

- [x] T011 [P] [US1] Unit test: nav config shape validation in `tests/unit/nav/nav-config.test.ts` — staffNavConfig has 4 top-level items (Dashboard, Plans, Users, Settings group), Settings group has children (Fees), all items have titleKey + icon + href + activePattern
- [x] T012 [P] [US1] Unit test: active-state matching in `tests/unit/nav/active-state.test.ts` — exact match `/admin` → Dashboard active, prefix `/admin/plans/2026/abc` → Plans active, `/admin/settings/fees` → Fees active + Settings group expanded, `/admin/unknown` → no item active, deepest-match-wins logic
- [x] T013 [P] [US1] ~~Unit test: sidebar state hook~~ — SKIPPED: shadcn SidebarProvider handles state internally; no custom hook to test — localStorage read/write, cookie sync, fallback to expanded when localStorage throws, fallback when cookie unavailable

### Implementation for US1

- [x] T014 [US1] Create `src/components/layout/nav-item.tsx` — shared nav item renderer that handles both NavItem (flat link) and NavGroup (expandable collapsible group with children). Uses `usePathname()` + `isNavItemActive()` for active state. NavGroup auto-expands when active child matches. Single-child NavGroup renders as flat link. Icons at 20×20px. Active state uses background/border accent per design system tokens. Long labels truncated with ellipsis.
- [x] T015 [US1] Create `src/components/layout/staff-sidebar.tsx` — wraps shadcn `<Sidebar>` component. Renders tenant name at top (truncated with ellipsis, compact identifier when collapsed). Maps `staffNavConfig` sections through `NavItem` renderer. Uses `<nav>` landmark with `aria-label="Staff navigation"`. Supports light/dark themes via CSS variables.
- [x] T016 [US1] Modify `src/app/(staff)/admin/layout.tsx` — wrap content with `<SidebarProvider>`. Add `<StaffSidebar />` to the left of the content area. Move existing header (ThemeToggle, UserMenu) inside `<SidebarInset>`. Read `sidebar:state` cookie on the server to pass correct `defaultOpen` prop to `<SidebarProvider>`. Preserve existing CommandPaletteRoot and IdleWarningDialog.

**Checkpoint**: Staff sidebar visible on all admin pages, active state works, tenant name shown. Verify by signing in as admin and navigating between Dashboard/Plans/Users/Settings.

---

## Phase 4: User Story 2 — Collapsible Sidebar (P1)

**Goal**: Staff users can collapse sidebar to icon-only rail and expand it back, with preference persisted across sessions via localStorage + cookie.

**Independent Test**: Click collapse toggle → sidebar shrinks to icons only → hover shows tooltip → click expand → sidebar restores → navigate to another page → preference persists → sign out + sign in → preference still persists.

### Implementation for US2

- [x] T017 [US2] Create `src/components/shell/sidebar-toggle.tsx` — collapse/expand toggle button with `aria-expanded` attribute. Uses `useSidebarState` hook. CSS transition 200–300ms ease-out. Respects `prefers-reduced-motion` (instant, no animation). Renders inside sidebar footer area.
- [x] T018 [US2] Update `src/components/layout/staff-sidebar.tsx` — integrate `<SidebarToggle />` in sidebar footer. When collapsed: show icon-only rail (~48px), hide text labels, show tooltips on hover. When expanded: show full ~240px sidebar with icons + labels. NavGroup items in collapsed mode show icon only with tooltip.
- [x] T019 [US2] Wire sidebar cookie sync into `src/app/(staff)/admin/layout.tsx` — connect localStorage + cookie sync to `<SidebarProvider open={…} onOpenChange={…}>`. Ensure server reads cookie for correct initial render (no hydration CLS).

**Checkpoint**: Sidebar collapses/expands smoothly, tooltips show on collapsed icons, preference persists across sessions. No layout shift on page load.

---

## Phase 5: User Story 3 — Mobile-Responsive Navigation (P2)

**Goal**: On viewports below 768px, sidebar hides and a hamburger button in the header opens it as a slide-out drawer overlay.

**Independent Test**: Resize browser to < 768px → sidebar hidden → hamburger button in header → tap → drawer slides in → tap nav link → drawer closes + page loads → tap outside/press Escape → drawer closes.

### Implementation for US3

- [x] T020 [US3] Update `src/components/layout/staff-sidebar.tsx` — configure shadcn Sidebar `collapsible="offcanvas"` for mobile breakpoint. Add semi-transparent backdrop overlay. Drawer renders below command palette in stacking order. Focus trap while drawer is open. Close on Escape, outside tap, or nav link click.
- [x] T021 [US3] Add hamburger toggle button to staff header in `src/app/(staff)/admin/layout.tsx` — visible only below 768px (Tailwind `md:hidden`), aligned to the left in header bar. Uses `<SidebarTrigger />` from shadcn. Hidden on desktop.
- [x] T022 [US3] Handle viewport resize across breakpoint — handled by shadcn Sidebar's built-in `useIsMobile()` hook + Sheet component — ensure seamless switch between persistent sidebar (≥768px) and drawer mode (<768px). If mobile drawer was open and user resizes to desktop, drawer closes and persistent sidebar appears.

**Checkpoint**: Mobile drawer works at 320px–767px. Hamburger button visible. All close mechanisms work (outside tap, Escape, link click). No horizontal overflow at 320px.

---

## Phase 6: User Story 4 — Member Portal Navigation (P2)

**Goal**: Member users see a horizontal top nav bar in `/portal/**` with links to Dashboard and Account.

**Independent Test**: Sign in as member → nav bar visible → click Account → page loads → Account highlighted → resize to mobile → nav adapts responsively.

### Implementation for US4

- [x] T023 [P] [US4] Create `src/components/layout/member-nav.tsx` — horizontal top navigation bar. Maps `memberNavConfig` items through a horizontal list with active-state highlighting (same visual tokens as staff sidebar). Uses `<nav>` landmark with `aria-label="Member navigation"`. Responsive: adapts to mobile via compact layout or hamburger (consistent with US3 pattern). Supports light/dark themes. i18n labels via `nav.member.*` keys.
- [x] T024 [US4] Modify `src/app/(member)/portal/layout.tsx` — add `<MemberNav />` below or integrated into the existing header area. Preserve existing auth guard and header components (ThemeToggle, UserMenu).

**Checkpoint**: Member nav visible on all portal pages, active state works, responsive on mobile. Verify by signing in as member.

---

## Phase 7: User Story 5 — Keyboard Accessibility (P3)

**Goal**: All nav elements are fully keyboard-navigable, meet WCAG 2.1 AA, with proper ARIA attributes, focus management, and reduced-motion support.

**Independent Test**: Tab through sidebar → logical order → Enter navigates → Escape closes drawer → focus returns to trigger → axe-core scan → zero critical/serious violations → reduced-motion → no animation.

### Tests for US5

- [x] T025 [P] [US5] E2E test: staff sidebar in `tests/e2e/staff-sidebar.spec.ts` — sidebar renders on admin pages, active state correct per route, collapse/expand works (including rapid toggle 5× without glitch), mobile drawer opens/closes, nav links route correctly
- [x] T026 [P] [US5] E2E test: member nav in `tests/e2e/member-nav.spec.ts` — nav bar renders on portal pages, active state correct, responsive on mobile viewport
- [x] T027 [P] [US5] E2E a11y test: navigation accessibility in `tests/e2e/nav-a11y.spec.ts` — axe-core scan on admin pages (sidebar expanded + collapsed), axe-core on portal pages, keyboard Tab order through sidebar items, Enter navigates, Escape closes mobile drawer + focus returns to hamburger, `aria-expanded` on collapse toggle, `aria-label` on `<nav>` landmarks, reduced-motion: instant state changes

### Implementation for US5

- [x] T028 [US5] Audit and fix ARIA attributes across all nav components — verify `<nav>` landmarks have descriptive `aria-label`, collapse toggle has `aria-expanded`, NavGroup headers have `aria-expanded`, all interactive elements are keyboard-focusable
- [x] T029 [US5] Implement focus management for mobile drawer — handled by shadcn Sheet (base-ui Dialog) built-in focus trap — focus trap while open, focus returns to hamburger button on close, Escape key handling
- [x] T030 [US5] Add `prefers-reduced-motion` media query support to all nav animations — collapse/expand transition, mobile drawer slide, backdrop fade. Instant state changes when reduced-motion is enabled. Apply in `src/components/layout/staff-sidebar.tsx` and `src/components/shell/sidebar-toggle.tsx`

**Checkpoint**: All axe-core scans pass with zero critical/serious nav violations. Keyboard-only navigation is fully functional. Screen readers announce state changes correctly.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, cleanup, and cross-cutting quality checks

- [x] T031 Run `pnpm lint` — verify zero ESLint errors across all new/modified files
- [x] T032 Run `pnpm typecheck` — verify zero TypeScript errors under strict mode
- [x] T033 Run `pnpm check:i18n` — verify all `nav.*` keys present in EN, TH, SV with no missing keys
- [x] T034 Run `pnpm test` — verify all unit tests pass (nav-config, active-state, sidebar-state)
- [x] T035 Run `pnpm test:e2e` — verify all E2E tests pass (staff-sidebar, member-nav, nav-a11y)
- [x] T036 Run `pnpm build` — verify production build is clean with no warnings
- [ ] T037 Visual review: verify light + dark theme consistency across staff sidebar, member nav, mobile drawer
- [ ] T038 Visual review: verify i18n labels render correctly in EN, TH, SV (no overflow, no missing translations, correct truncation)
- [ ] T039 Run quickstart.md validation — follow all 6 verification steps from `specs/003-nav-menu/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001 for shadcn sidebar)
- **US1 (Phase 3)**: Depends on Foundational — this is the MVP
- **US2 (Phase 4)**: Depends on US1 (needs sidebar to exist before adding collapse)
- **US3 (Phase 5)**: Depends on US1 (needs sidebar to exist before making it responsive)
- **US4 (Phase 6)**: Depends on Foundational only — can run in parallel with US1/US2/US3
- **US5 (Phase 7)**: Depends on US1 + US2 + US3 + US4 (all nav components must exist before a11y audit)
- **Polish (Phase 8)**: Depends on all user stories complete

### User Story Dependencies

```
Phase 1: Setup
    ↓
Phase 2: Foundational
    ↓
    ├── Phase 3: US1 Staff Sidebar (P1) ← MVP
    │       ↓
    │   Phase 4: US2 Collapsible (P1)
    │       ↓
    │   Phase 5: US3 Mobile (P2)
    │
    └── Phase 6: US4 Member Nav (P2) ← parallel with US1-US3
            ↓
        Phase 7: US5 Accessibility (P3) ← depends on ALL nav existing
            ↓
        Phase 8: Polish
```

### Parallel Opportunities

- **T002/T003/T004/T005**: All setup tasks after T001 can run in parallel
- **T011/T012/T013**: All US1 unit tests can run in parallel
- **T025/T026/T027**: All US5 E2E tests can run in parallel
- **US4 (Phase 6)** can run in parallel with US1-US3 (different portal, different component)

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001–T005)
2. Complete Phase 2: Foundational (T006–T010)
3. Complete Phase 3: US1 Staff Sidebar (T011–T016)
4. **STOP and VALIDATE**: Sign in as admin → sidebar visible → active state correct → tenant name shown
5. This alone delivers the core navigation value

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US1 Staff Sidebar → Test → **MVP shipped**
3. US2 Collapsible → Test → Sidebar collapse works
4. US3 Mobile → Test → Responsive nav works
5. US4 Member Nav → Test → Member portal has navigation
6. US5 Accessibility → Test → WCAG 2.1 AA compliant
7. Polish → Full CI pipeline green → Ready for review

---

## Notes

- [P] tasks = different files, no dependencies between them
- [Story] label maps task to specific user story for traceability
- Constitution Principle II requires tests BEFORE implementation — unit tests in US1, E2E tests in US5 (after components exist for Playwright to target)
- Commit after each task or logical group
- Stop at any checkpoint to validate independently
- Total: **39 tasks** across 8 phases
