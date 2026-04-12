# Research: Navigation Menu (003-nav-menu)

**Date**: 2026-04-12

## R1 — Sidebar Component Strategy

**Decision**: Use the **shadcn/ui Sidebar component** (`npx shadcn@latest add sidebar`).

**Rationale**: shadcn/ui sidebar is a first-party component built on Radix primitives that the project already uses (Tooltip, Sheet, etc.). It provides collapsible rail mode, mobile Sheet drawer, keyboard navigation, and theming out of the box — matching all 5 user stories without custom implementation. The project already uses shadcn/ui extensively (`components.json` confirms `base-nova` style, lucide icons, CSS variable theming).

**Alternatives considered**:
- **Custom sidebar from scratch** — Rejected: duplicates work that shadcn sidebar already provides; violates Principle X (YAGNI/Simplicity).
- **Radix NavigationMenu primitive** — Rejected: designed for horizontal menus/dropdowns, not vertical sidebars with collapse/rail.
- **Third-party sidebar library (react-pro-sidebar, etc.)** — Rejected: adds external dependency when shadcn/ui already covers the need within the existing design system.

## R2 — Navigation Configuration Pattern

**Decision**: Define nav items as a **typed TypeScript config array** (`src/config/nav.ts`) with `NavItem`, `NavGroup`, and `NavSection` types. Each entry has: `titleKey` (i18n), `icon` (lucide component), `href`, `activePattern` (regex or prefix match), optional `children`, optional `roles` filter.

**Rationale**: Data-driven nav config is required by FR-009. A central config file means adding a new page requires only one new array entry. TypeScript typing ensures compile-time safety for missing icons or broken hrefs.

**Alternatives considered**:
- **Database-stored nav config** — Rejected: overkill for a single-tenant deployment; nav changes deploy with code anyway. Constitution Principle X (YAGNI).
- **Inline JSX nav items** — Rejected: violates FR-009 (adding a page requires structural changes, not just config).

## R3 — Collapse State Persistence

**Decision**: Use **`localStorage`** with key `sidebar-collapsed` (boolean). Persists across sessions per clarification Q1.

**Rationale**: Simplest persistence mechanism for a UI preference. No server round-trip, no DB schema, no cookie overhead. shadcn sidebar component supports external state control via `defaultOpen` / `open` / `onOpenChange` props.

**Alternatives considered**:
- **sessionStorage** — Rejected per clarification Q1 (user wants persistence across sessions).
- **Cookie** — Rejected: unnecessary server-side awareness for a purely client-side UI state; adds Set-Cookie overhead.
- **User preferences table** — Rejected: no database schema changes for a UI preference (Principle X).

## R4 — Member Portal Navigation Pattern

**Decision**: Use a **horizontal top navigation bar** for the member portal, not a full sidebar.

**Rationale**: The member portal currently has only 2 pages (Dashboard, Account) and will grow slowly (F3 adds ~2-3 more). A sidebar is overkill; a horizontal nav bar is lighter and more familiar for member-facing portals. When page count exceeds ~6, the member portal can migrate to sidebar using the same nav config pattern.

**Alternatives considered**:
- **Full sidebar (same as staff)** — Rejected: too heavy for 2-5 pages; wastes horizontal space on what is primarily a read-only portal.
- **Tab-based navigation** — Rejected: tabs imply content on the same page, not page navigation.

## R5 — i18n Key Namespace

**Decision**: New namespace `nav.staff.*` for staff sidebar labels and `nav.member.*` for member nav labels. Section headers use `nav.staff.sections.*`.

**Rationale**: Keeps nav translations isolated from existing `admin.*` and `shell.*` namespaces. Follows the existing pattern of feature-scoped i18n keys.

## R6 — Active State Detection

**Decision**: Use **pathname prefix matching** via `usePathname()` from Next.js. Each nav item defines an `activePattern` (string prefix, e.g., `/admin/plans`). The deepest matching item wins (most specific prefix). NavGroups auto-expand when any child matches.

**Rationale**: Prefix matching is simple, deterministic, and handles nested routes naturally (e.g., `/admin/plans/2026/abc123` matches the `/admin/plans` item). No regex complexity needed for the current route structure.

**Alternatives considered**:
- **Exact match** — Rejected: fails for nested routes (plan detail pages wouldn't highlight Plans).
- **Regex patterns** — Rejected: unnecessary complexity for the current URL structure. Can be added later if needed.

## R7 — Layout Restructure

**Decision**: Convert the staff portal from a **single-column header+content** layout to a **sidebar+header+content** layout. The sidebar sits left of the content area. The header moves inside the content area (right of sidebar) to avoid spanning the full viewport width when sidebar is visible.

**Rationale**: Standard admin dashboard pattern. The existing `max-w-6xl` constraint on content area stays; the sidebar adds ~240px (expanded) or ~48px (collapsed) to the left. The header's ThemeToggle and UserMenu remain in the header bar.

**Key implementation detail**: The `<SidebarProvider>` wraps the staff layout. The existing `<main>` becomes `<SidebarInset>` content area. Mobile breakpoint triggers Sheet-based drawer via shadcn sidebar's built-in responsive behaviour.
