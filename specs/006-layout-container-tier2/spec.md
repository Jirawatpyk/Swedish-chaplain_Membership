# Feature Specification: Layout Container Tier 2 — Content-Type-Based Width System

**Feature Branch**: `006-layout-container-tier2`
**Created**: 2026-04-18
**Status**: Draft
**Input**: User description: "Layout Container Tier 2 — Content-Type-Based Width System"

## Clarifications

### Session 2026-04-18

- Q: Lock exact width values for the three containers? → A: Form 42rem / Detail 72rem / Table 96rem (locked, no per-page exceptions)
- Q: `ContentContainer` deprecation strategy? → A: Remove outright in the same PR; no alias retained
- Q: Horizontal-scroll / width regression coverage? → A: Playwright viewport assertions (`scrollWidth <= clientWidth`) on 1 representative page per container category × 3 viewport widths (1280 / 1440 / 1920)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin views data-dense tables without horizontal scroll (Priority: P1)

A chamber administrator opens the Members directory (10 columns), Users list, or Plans list on a 1280px+ monitor. Today the content is squeezed into a 72rem (1152px) column which forces inner horizontal scrolling on tables with many columns, hiding key information below the fold. The administrator expects data-dense screens to use the available viewport width so rows fit on one line and all columns are visible without scrolling.

**Why this priority**: Data-dense admin screens are the daily workhorse for chamber staff (member management, invoicing, renewal tracking). Horizontal scroll on tables is the single biggest UX complaint surfaced by F3 feedback and the primary motivation for this feature. Delivering just this story already unlocks most of the user value.

**Independent Test**: Open `/admin/members`, `/admin/users`, `/admin/plans` at 1280px, 1440px, and 1920px viewport widths. Verify no horizontal scroll appears on the table surface and all columns are visible simultaneously.

**Acceptance Scenarios**:

1. **Given** a viewport ≥1280px wide, **When** an admin opens any table-dense page, **Then** the table fills the available content area without inner horizontal scroll and without exceeding a readable outer bound.
2. **Given** a viewport between 768px and 1279px, **When** the same page is opened, **Then** the table remains responsive (existing horizontal scroll or stacking behaviour preserved) and does not regress from today.
3. **Given** a viewport of 1920px (common monitor), **When** the admin opens the members directory, **Then** the table area is visibly wider than 72rem (≥96rem or full content width minus safe gutters) and uses the new TableContainer.

---

### User Story 2 - Staff and members fill forms with comfortable line length (Priority: P2)

A staff user updates fee settings on `/admin/settings/fees`, and a member edits their profile on `/portal/account`. Today these single-column forms stretch to 72rem, leaving inputs so wide that labels and values feel disconnected and long text fields exceed the comfortable reading line length (~80 characters). Users expect form pages to sit in a narrower, focused column that keeps inputs legible and reduces eye movement.

**Why this priority**: Form ergonomics are a known readability issue but lower volume than table usage. Shipping this story independently still improves settings, account, and plan-creation flows without touching tables.

**Independent Test**: Open `/admin/account`, `/admin/settings/fees`, `/admin/plans/new`, `/portal/account` on any viewport. Verify the form column is constrained to ~42rem and average input/text line length does not exceed 80 characters.

**Acceptance Scenarios**:

1. **Given** a viewport ≥768px, **When** a user opens any form-focused page, **Then** the form sits in a ≤42rem column centred (or left-aligned per existing layout convention) within the outer shell.
2. **Given** a very wide viewport (≥1920px), **When** the same form opens, **Then** the form column does NOT expand beyond the form bound — surrounding whitespace is acceptable.
3. **Given** an error or success toast, **When** it appears, **Then** toast positioning is unaffected by the new container (toasts remain viewport-anchored).

---

### Edge Cases

- **Very wide ultrawide monitors (≥2560px)**: TableContainer must cap at a readable bound (e.g., 96rem or 120rem) rather than stretching to full width, to avoid over-long table rows that strain horizontal eye tracking.
- **Narrow viewports (<768px / mobile)**: All three containers collapse to full-width minus existing page gutters — no divergence from F4 mobile behaviour.
- **Sidebar collapsed vs expanded**: Container width is measured from the content area (inside the staff shell), not the full viewport. Sidebar state must not cause layout shift beyond the existing transition.
- **Print stylesheet**: Containers should not override `@media print` rules; existing print layout is preserved.
- **Pages with mixed content (e.g., plan detail has a summary card + a members table)**: The page author picks the container matching the **primary** content type. Nested wider content (e.g., an embedded table) may locally opt into `overflow-x: auto` within the DetailContainer.
- **Legacy pages still on ContentContainer after migration window**: If kept as an alias, visual behaviour is identical to DetailContainer; if removed, the build fails loudly rather than silently stretching.
- **Client-side route transitions**: Switching between a form page (42rem) and a table page (96rem) must not cause cumulative layout shift on content that stays visible (header, sidebar).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide three named layout containers — `TableContainer`, `FormContainer`, and `DetailContainer` — each encoding a single semantic page content type.
- **FR-002**: `TableContainer` MUST cap content width at exactly **96rem** on viewports ≥1280px so data-dense tables use the available area without exceeding a readable horizontal eye-scan bound.
- **FR-003**: `FormContainer` MUST cap content width at exactly **42rem** so average line length stays within ~80 characters for body text and inputs.
- **FR-004**: `DetailContainer` MUST cap content width at exactly **72rem** — identical to the current F4 ContentContainer — so detail, dashboard, and mixed pages show zero visible regression.
- **FR-005**: Each container MUST be a pure presentation primitive — no domain, application, or infrastructure imports; no i18n keys; no new runtime dependencies.
- **FR-006**: The system MUST migrate every existing admin and member-portal route to the container that matches its primary content type per the Content-Type Mapping in Assumptions.
- **FR-007**: Every one of the 19 migrated routes MUST have its sibling `loading.tsx` updated to wrap the skeleton in the same container as its `page.tsx`. A route whose `loading.tsx` is missing MUST have one added as part of this feature. First-paint and hydrated-paint outer widths MUST be identical, eliminating skeleton-to-content layout shift.
- **FR-008**: The system MUST update `docs/ux-standards.md` with a Container Selection Guideline that includes (a) a one-line decision rule (table / form / detail), (b) the complete content-type mapping table, (c) three minimal code examples — one per primitive, and (d) an explicit note that `ContentContainer` has been removed. The three new primitives MUST be discoverable via the `src/components/layout` barrel export so page authors find them via IntelliSense.
- **FR-009**: The legacy `ContentContainer` primitive MUST be removed from `src/components/layout/` in the same PR that introduces the three new containers; any lingering import after migration MUST fail the build.
- **FR-010**: All three containers MUST preserve WCAG 2.1 AA compliance and introduce no new accessibility regressions (focus order, landmarks, reading order, zoom behaviour up to 200%). **Verification mechanism**: the existing `@axe-core/playwright` E2E suite MUST pass unchanged on every migrated route; a new failing axe rule attributable to this feature is a merge blocker.
- **FR-011**: The containers MUST behave responsively across three viewport bands: (a) **<768px (mobile)** — collapse to full width minus the existing `--page-padding-x` gutter; (b) **768px ≤ viewport < container-cap (tablet / small desktop)** — scale fluidly at 100% minus gutter; (c) **≥ container-cap (large desktop)** — remain capped at the semantic width (42 / 72 / 96 rem) centred via `mx-auto`. Band boundaries MUST NOT cause layout jump; transitions use Tailwind's native breakpoint cascade.
- **FR-012**: The system MUST keep all existing unit and contract tests green after migration; any test that hard-codes container class names or widths MUST be updated to reference the new primitive.
- **FR-013**: Route transitions between pages using different containers MUST NOT cause cumulative layout shift on persistent chrome (sidebar, top bar, breadcrumbs).
- **FR-014**: The public barrel export of `src/components/layout/` MUST surface the three new containers so routes can import them without reaching into file paths.
- **FR-015**: The three containers MUST NOT set `overflow-x` at their root element. Horizontal overflow for wide tables is owned by the shadcn `<Table>` component, which already wraps its `<table>` in an `overflow-x-auto` scroller. Any page embedding a raw `<table>` (not using shadcn `<Table>`) MUST wrap it locally in `<div class="overflow-x-auto">`; this is a documentation requirement in `docs/ux-standards.md` and in the feature quickstart.
- **FR-016**: Performance budgets in scope are limited to Cumulative Layout Shift (SC-007). LCP, INP, TTFB, and other Web Vitals are explicitly **out of scope** for this feature — the change is presentation-only with no new render-blocking assets, fonts, or network calls.
- **FR-017**: The Thai line-break hedge `:lang(th) { line-break: loose; word-break: normal; }` MUST be added to `src/app/globals.css` alongside the token swap. Rationale is documented in research §R9b; behaviour is global (improves Thai line-breaking everywhere), not scoped to any single container.
- **FR-018 (Scope gate)**: This feature MUST NOT introduce (a) new runtime dependencies, (b) new i18n keys or translated strings, (c) new database tables, columns, migrations, or indexes, (d) new API endpoints, route handlers, or server actions, (e) new audit event types, (f) new RBAC rules, or (g) new observability metrics or log fields. Any diff touching these surfaces is a scope violation and a merge blocker.
- **FR-019**: SC-005's "zero horizontal scrollbars" applies to the **document body** (`document.documentElement.scrollWidth <= clientWidth`), NOT to inner scroll wrappers. When a table's natural width exceeds 96rem at ≥1280px viewport, horizontal scroll MUST be absorbed locally by the shadcn `<Table>` component's `overflow-x-auto` wrapper (per FR-015), leaving the body non-scrolling. This reconciles the "wide table that cannot actually fit 96rem" case with SC-005.

### Key Entities

- **TableContainer**: Layout primitive for data-dense surfaces (directories, audit logs, e-blast history). Conveys intent "this page's primary value is a wide table."
- **FormContainer**: Layout primitive for single-column input pages (create, edit, settings, account). Conveys intent "this page's primary value is a focused form."
- **DetailContainer**: Layout primitive for mixed-content pages (dashboards, detail views, landing pages). Default choice when neither table nor form dominates.
- **Container Selection Guideline**: Documented decision rule in `docs/ux-standards.md` that page authors consult when introducing a new route.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of admin and portal table-dense pages (as enumerated in the Content-Type Mapping) render inside `TableContainer` after the migration.
- **SC-002**: 100% of form-focused pages render inside `FormContainer` with measured inner column width ≤42rem on viewports ≥768px.
- **SC-003**: 100% of detail and mixed pages render inside `DetailContainer` with outer width unchanged from the pre-migration ContentContainer baseline (±0 px at 1440px viewport).
- **SC-004**: `ContentContainer` is fully removed from the codebase post-ship; a repo-wide grep returns zero matches and `pnpm build` fails loudly on any attempted reintroduction.
- **SC-005**: Zero horizontal scrollbars appear on any table-dense page at viewport widths 1280px, 1440px, and 1920px, verified by Playwright E2E assertions (`document.documentElement.scrollWidth <= clientWidth`) on one representative page per container category (3 pages × 3 widths = 9 assertions).
- **SC-006**: Average input/body-text line length on form-focused pages stays within 80 characters, measured as follows — open each of `/admin/settings/fees`, `/admin/plans/new`, `/portal/account` at 1440px viewport in the EN locale, select three representative body-text or helper-text nodes per page, and compute `characters-per-line = getBoundingClientRect().width / 1em`; mean across all nine samples MUST be ≤80. Recorded as a manual Review-gate measurement, not automated, since locale font metrics vary.
- **SC-007**: Cumulative Layout Shift (CLS) on persistent chrome during route transitions between container types is ≤0.02, measured by a Playwright test that navigates between a FormContainer page and a TableContainer page and collects CLS via `PerformanceObserver({ type: 'layout-shift' })` for the duration of the transition.
- **SC-008**: The full existing unit + contract + integration test suite (≥800 unit+contract, ≥300 integration per current F3 state) passes with zero new failures attributable to this feature.
- **SC-009**: The UX standards documentation update is discoverable via a Table of Contents entry and ships in the same PR as the primitives.

## Assumptions

- **Dependency on F3 ship**: This feature starts after F3 (Members & Contacts) merges to `main`. The migration scope includes F3 routes (`/admin/members` and member detail pages), so starting earlier would create merge churn.
- **Non-regression requirement (detail/dashboard pages)**: Detail, dashboard, and mixed-content pages (per the Content-Type Mapping) MUST render with exact F4 `ContentContainer` parity — 72rem outer width at 1440px viewport, ±0 px. Verified by SC-003; not modelled as a user story because the user-visible change is intentionally zero.
- **Content-Type Mapping (authoritative, all 19 current post-F3 routes enumerated — verified by `find src/app/(staff)/admin src/app/(member)/portal -name page.tsx`)**:
  - **TableContainer (3 current)**: `/admin/users`, `/admin/plans`, `/admin/members`. Future: `/admin/invoices`, `/admin/e-blast`, `/admin/renewal`, `/admin/audit`.
  - **FormContainer (10 current)**: `/admin/account`, `/admin/settings/fees`, `/admin/plans/new`, `/admin/plans/clone`, `/admin/plans/[year]/[planId]/edit`, `/admin/members/new`, `/admin/members/[memberId]/edit`, `/portal/account`, `/portal/edit`, `/portal/contacts/invite`. Future: `/admin/invoices/new`, `/admin/invoices/[id]/edit`.
  - **DetailContainer (6 current)**: `/admin` (dashboard), `/admin/plans/[year]/[planId]`, `/admin/members/[memberId]`, `/admin/members/[memberId]/timeline`, `/portal`, `/portal/profile`. Future: `/admin/invoices/[id]`, member-detail variants.
  - **Total**: 3 + 10 + 6 = 19 routes. Each route MUST appear in exactly one category; any route not listed above is out of scope for this feature and will be flagged by the CI static check (`scripts/check-layout-container-usage.ts`).
- **Readable width caps** are **locked** at 42rem / 72rem / 96rem (form / detail / table), matching Stripe, Linear, and Vercel dashboard conventions. These values are canonical and not tunable per page; a future change requires a spec amendment.
- **Pre-ship Review-gate check (plan-detail page)**: Before PR merge, a reviewer MUST render `/admin/plans/[year]/[planId]` with a plan containing ≥5 members and visually confirm the embedded members-by-plan table reads cleanly inside the 72rem DetailContainer (the shadcn `<Table>` overflow-x wrapper is expected to absorb any width excess). If the table feels cramped, reclassify this route to `TableContainer` and update the Content-Type Mapping in this document. This is a **Review-gate requirement**, not just a research note.
- **Overflow ownership** (see FR-015): shadcn `<Table>` owns horizontal scrolling at the `data-slot="table-container"` wrapper. Containers never set `overflow-x`. Raw `<table>` elements are NOT permitted inside the three new containers without a local `overflow-x-auto` wrapper.
- **Thai line-break hedge** (see FR-017): globals.css adds a `:lang(th)` rule for Thai line-breaking. Orthogonal to width locks; no SC added; verified manually during the Review gate.
- **Performance scope**: Only CLS (SC-007) is in scope. LCP / INP / TTFB are explicitly excluded — presentation-only change, no new assets or network calls.
- **Sidebar + shell chrome** from F1/F3/F4 remain untouched; containers live strictly inside the existing page content area.
- **No new dependencies, no i18n keys, no schema/API changes** — the feature is purely presentational.
- **Deprecation strategy**: `ContentContainer` is removed outright in the same PR — no alias retained. All 19 pages are migrated inside this feature, so a hard removal guarantees zero drift.
- **Visual regression coverage**: Playwright viewport assertions (`scrollWidth <= clientWidth`) on one representative page per container category × three viewport widths (1280/1440/1920) are sufficient; full screenshot-diff baselines are out of scope.
- **Ultrawide monitor handling**: The 96rem cap on `TableContainer` is the baseline; if a future table legitimately needs full-bleed (e.g., an analytics grid), a page-level opt-out mechanism can be added later without changing the three-container contract.
