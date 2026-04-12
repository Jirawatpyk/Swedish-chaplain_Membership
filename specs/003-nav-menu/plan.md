# Implementation Plan: Navigation Menu

**Branch**: `003-nav-menu` | **Date**: 2026-04-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/003-nav-menu/spec.md`

## Summary

Add persistent sidebar navigation to the staff portal and a horizontal top nav bar to the member portal. The staff sidebar is collapsible to an icon-only rail with localStorage persistence, transforms into a mobile drawer on small screens, and supports expandable groups (Settings → sub-items). All nav items are data-driven via a typed config array. Uses the shadcn/ui Sidebar component built on existing Radix primitives. No database changes — pure presentation layer.

## Technical Context

**Language/Version**: TypeScript 5.7+ (strict mode) / Node 22 LTS  
**Primary Dependencies**: Next.js 16 App Router, React 19, shadcn/ui (Sidebar, Sheet, Tooltip), Tailwind CSS v4, lucide-react, next-intl, next-themes  
**Storage**: N/A — no database changes. Client-side localStorage for collapse preference.  
**Testing**: Vitest (unit: nav config, active-state logic), Playwright + axe-core (e2e: sidebar rendering, collapse, mobile drawer, a11y)  
**Target Platform**: Web (Vercel sin1 Singapore)  
**Project Type**: Web application (Next.js App Router)  
**Performance Goals**: Sidebar collapse/expand animation < 300ms. No measurable increase in LCP on admin pages.  
**SSR State Sync**: Sidebar collapse preference is synced to the server via a lightweight cookie (`sidebar:state`) to prevent hydration mismatch / layout shift (CLS). The cookie is read in the server layout to render the correct initial sidebar state. Graceful fallback: if localStorage or cookie is unavailable, default to expanded.  
**Constraints**: WCAG 2.1 AA compliance. 3 locales (EN/TH/SV). Light + dark theme support.  
**Scale/Scope**: ~12 new/modified files. ~15 new i18n keys × 3 locales (~45 entries). 0 database migrations.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.4.0*

**NON-NEGOTIABLE gates** (any FAIL blocks the plan; no waivers):

- [x] **I. Data Privacy & Security** — No new PII collected or processed. No new protected routes added. No new data storage. No tenant-scoped data. Feature is pure UI navigation over existing authenticated pages. RBAC is unchanged — nav visibility may filter by role but does not grant new permissions.
- [x] **II. Test-First Development** — Unit tests planned for nav config and active-state matching logic. E2E tests planned for sidebar rendering, collapse/expand, mobile drawer, keyboard navigation, and axe-core a11y scans. Tests written before implementation per TDD discipline.
- [x] **III. Clean Architecture** — Feature is entirely in the **Presentation layer** (components, layout, config). No domain, application, or infrastructure changes. No module boundary violations. Nav config lives in `src/config/` (presentation-adjacent utility). No new bounded context needed — nav is cross-cutting UI infrastructure.
- [x] **IV. Payment Security (PCI DSS)** — N/A. No payment surfaces touched.

**Core principle gates** (FAIL must be justified in Complexity Tracking):

- [x] **V. Internationalization (SV/EN/TH)** — All nav labels use i18n keys under `nav.staff.*` and `nav.member.*` namespaces. EN/TH/SV translations provided. Existing `check:i18n` CI script validates coverage.
- [x] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — Mobile-first: sidebar transforms to Sheet drawer below 768px. Keyboard navigation via Tab/Enter/Escape. axe-core e2e tests for a11y. Tooltip on collapsed icons for screen readers. Focus management on drawer open/close.
- [x] **VII. Performance & Observability** — Sidebar is a client component but lightweight (no data fetching). Collapse animation uses CSS transitions (GPU-accelerated). No new API calls. No observable impact on LCP/INP/CLS. No new logging/metrics needed (pure UI).
- [x] **VIII. Reliability** — No state-changing endpoints. No transactional boundaries. No audit log entries (nav interaction is not a security event). Error states: if nav config is empty, render empty sidebar gracefully (no crash).
- [x] **IX. Code Quality Standards** — TypeScript strict mode. ESLint clean. Components follow existing shadcn/ui patterns. Solo-maintainer substitute applies (single developer — documented in F1 plan Complexity Tracking and applies to all features until a second maintainer joins).
- [x] **X. Simplicity (YAGNI)** — Uses existing shadcn/ui Sidebar component instead of custom build. Data-driven config instead of hardcoded JSX. No speculative features (breadcrumbs, badges, notification indicators deferred). localStorage instead of server-side preference storage.

## Project Structure

### Documentation (this feature)

```text
specs/003-nav-menu/
├── plan.md              # This file
├── research.md          # Phase 0: technology decisions
├── data-model.md        # Phase 1: client-side type definitions
├── quickstart.md        # Phase 1: developer setup guide
├── contracts/
│   └── nav-config-contract.md  # Internal nav registration contract
├── checklists/
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── config/
│   └── nav.ts                              # NEW — NavConfig types + staffNavConfig + memberNavConfig
├── components/
│   ├���─ ui/
│   │   └── sidebar.tsx                     # NEW — shadcn/ui Sidebar primitive (installed via CLI)
│   ├─�� layout/
│   │   ├── staff-sidebar.tsx               # NEW — Staff sidebar (wraps shadcn Sidebar with nav config)
│   │   ├── member-nav.tsx                  # NEW — Member horizontal top nav bar
│   │   └── nav-item.tsx                    # NEW — Shared nav item renderer (handles NavItem + NavGroup)
│   └── shell/
│       └── sidebar-toggle.tsx              # NEW — Collapse/expand toggle button
├── app/
│   ├── (staff)/admin/layout.tsx            # MODIFIED — Add SidebarProvider + StaffSidebar
│   └── (member)/portal/layout.tsx          # MODIFIED — Add MemberNav to header area
├── hooks/
│   └── use-sidebar-state.ts                # NEW — localStorage + cookie sync for collapse state, graceful fallback
└── i18n/messages/
    ├── en.json                             # MODIFIED — Add nav.staff.* + nav.member.* keys
    ├── th.json                             # MODIFIED — Add nav.staff.* + nav.member.* keys
    └── sv.json                             # MODIFIED — Add nav.staff.* + nav.member.* keys

tests/
├── unit/nav/
│   ├── nav-config.test.ts                  # NEW — Config shape, type safety, all items have i18n keys
│   ├── active-state.test.ts                # NEW — Prefix matching logic, deepest-match-wins, Dashboard exact-match
│   └── sidebar-state.test.ts              # NEW — localStorage fallback, cookie sync, graceful degradation
└── e2e/
    ├── staff-sidebar.spec.ts               # NEW — Sidebar render, collapse, expand, mobile drawer
    ├── member-nav.spec.ts                  # NEW — Member nav render, active state, responsive
    └── nav-a11y.spec.ts                    # NEW — axe-core scans, keyboard navigation, focus management
```

**Structure Decision**: Pure presentation feature — all new code lives in `src/components/`, `src/config/`, `src/hooks/`, and test files. No changes to `src/modules/` bounded contexts. Two existing layout files modified to integrate the new navigation components.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Solo-maintainer review substitute (Principle IX) | Single developer on the project | Full ≥2-reviewer rule inapplicable — same substitute documented in F1 plan Complexity Tracking. Automated review passes + test coverage serve as substitute. |
| E2E tests deferred to Phase 7 (Principle II) | Playwright requires rendered DOM — cannot write failing E2E tests before components exist | Writing E2E stubs that import non-existent components would produce compile errors, not meaningful red tests. Unit tests (T011-T013) cover logic layer before impl. E2E tests (T025-T027) validate visual/behavioral layer after all nav components exist. Manual checkpoint verification at each phase mitigates the gap. |
