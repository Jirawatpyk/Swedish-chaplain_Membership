# Research: F4 — Page Layout Enterprise Standardization & Responsive Design

**Branch**: `004-page-layout-standard` | **Date**: 2026-04-12
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

## 1. Breadcrumb Label Resolution Strategy

**Decision**: Use React Context (BreadcrumbProvider) in the admin layout, with pages calling `useBreadcrumbLabels()` to register dynamic labels.

**Rationale**: Dynamic route segments like `/admin/plans/2026/[planId]` need human-readable labels (e.g., "Corporate Gold" instead of a UUID). The page component already has this data from its data fetch. A Context-based approach lets the page register its label without prop drilling through 3-4 layout levels. This is the standard React pattern for cross-cutting data that flows "up" from a child to an ancestor's render output.

**Alternatives considered**:
- **Prop drilling through layouts**: Rejected — Next.js App Router layouts don't receive props from child pages. Would require lifting data fetches into layouts, duplicating queries.
- **URL-based auto-resolution**: Rejected — would need a dedicated API endpoint to resolve UUIDs to names, adding network requests to the breadcrumb (contradicts Clarification Q2).
- **Static segment-only breadcrumbs**: Rejected — dynamic segments showing raw slugs/UUIDs provide poor UX for nested plan pages.

**Implementation sketch**: `BreadcrumbProvider` holds a `Map<string, string>` of segment → label. Pages call `setBreadcrumbLabel(segment, label)` in a `useEffect`. The `BreadcrumbNav` component reads the map to render human-readable labels. Static segments (admin, plans, users, settings) use i18n keys directly.

## 2. Admin Content Max-Width Standard

**Decision**: `max-w-6xl` (72rem / 1152px) as the default outer container, defined as a CSS custom property `--content-max-width-admin: 72rem`.

**Rationale**: `max-w-6xl` is the widest constraint currently used in the codebase (Users page). It provides enough space for data tables and multi-column layouts while preventing content from becoming unreadable on ultrawide monitors. Inner components (forms, detail views) can apply their own narrower constraints (e.g., `max-w-4xl` for forms, `max-w-2xl` for narrow wizards).

**Alternatives considered**:
- **`max-w-5xl` (64rem)**: Rejected — too narrow for the Users table which already uses 6xl effectively.
- **`max-w-7xl` (80rem)**: Rejected — wider than needed for current content; would leave minimal margin on 1440px screens.
- **No default (full-bleed)**: Rejected — the Fees page demonstrated that unconstrained forms look poor on wide screens.

**Portal max-width**: Keep `max-w-5xl` (64rem) for the member portal as `--content-max-width-portal: 64rem`. The portal has simpler, narrower content (no data tables) and the existing 5xl works well.

## 3. Design Token Strategy

**Decision**: Add CSS custom properties in `globals.css` for layout dimensions. Use Tailwind's CSS-first approach (no `tailwind.config.ts` changes needed in v4).

**Tokens to add**:
```css
/* Layout design tokens */
--content-max-width-admin: 72rem;     /* 1152px — admin pages */
--content-max-width-portal: 64rem;    /* 1024px — member portal */
--page-padding-x: 1.5rem;            /* 24px — horizontal content padding */
--page-padding-y: 1.5rem;            /* 24px — vertical content padding */
--page-header-gap: 1.5rem;           /* 24px — gap between header and content */
--page-section-gap: 1.5rem;          /* 24px — gap between content sections */
```

**Rationale**: CSS custom properties align with the Tailwind v4 CSS-first approach already used in the project (all theme values are in `globals.css`, not a config file). Using tokens ensures SC-007 (no magic numbers) and makes future design system changes trivial.

**Alternatives considered**:
- **Tailwind theme extension**: Rejected — project uses CSS-first Tailwind v4 config, not `tailwind.config.ts`. Adding a config file would break convention.
- **Hardcoded Tailwind classes**: Rejected — violates SC-007 (traceability to named tokens) and makes global changes require editing every file.

## 4. Breadcrumb Mobile Truncation

**Decision**: On viewports < 640px, show only the immediate parent + current page, with a "..." ellipsis indicator for deeper ancestors.

**Rationale**: Mobile screens lack horizontal space for full breadcrumb trails. The immediate parent provides the most useful "back" navigation. Deeper ancestors are accessible via the sidebar navigation.

**Implementation**: BreadcrumbNav receives the full path array. On mobile (detected via Tailwind `sm:` breakpoint, not JS), CSS `hidden sm:inline` hides middle segments. The ellipsis is a static "..." text node shown only when segments are hidden.

**Alternatives considered**:
- **Scrollable breadcrumb**: Rejected — horizontal scrolling within breadcrumbs is a non-standard pattern that confuses users.
- **Dropdown for collapsed segments**: Rejected — adds interaction complexity for low-frequency use (how often does a user on mobile jump 3 levels up?).

## 5. PageHeader Action Overflow

**Decision**: Actions wrap to a second line below the title on narrow viewports. No overflow/dropdown menu.

**Rationale**: Admin pages in Chamber-OS have 1-3 action buttons maximum (e.g., "Create plan", "Invite user"). Wrapping is sufficient and keeps all actions immediately visible. An overflow menu adds unnecessary interaction cost (extra tap) for the small number of actions.

**Implementation**: PageHeader uses `flex flex-wrap gap-4` for the title + actions container. Title takes `flex-1 min-w-0` (allows shrinking), actions area uses `flex flex-wrap gap-2`. Below ~640px, actions naturally wrap below the title.

**Alternatives considered**:
- **Overflow dropdown menu**: Rejected — overkill for 1-3 buttons; adds a click to reach actions.
- **Hybrid (primary visible + secondary in menu)**: Rejected — complicates the component API with primary/secondary distinction for a maximum of 3 buttons.

## 6. shadcn/ui Breadcrumb Primitive

**Decision**: Install the shadcn/ui `breadcrumb` component as the base primitive, then wrap it with the project-specific `BreadcrumbNav` component that adds i18n, mobile truncation, and context-based label resolution.

**Rationale**: shadcn/ui provides a well-tested, accessible `<Breadcrumb>` + `<BreadcrumbList>` + `<BreadcrumbItem>` + `<BreadcrumbSeparator>` + `<BreadcrumbEllipsis>` set that handles ARIA roles correctly. Building on top of it (rather than from scratch) saves effort and ensures accessibility compliance.

**Verification needed**: Confirm `breadcrumb` component is available in the installed shadcn version. If not, install via `pnpm dlx shadcn@latest add breadcrumb`.

## 7. Migration Strategy

**Decision**: Migrate all existing pages within F4, achieving 100% adoption at ship.

**Pages to migrate** (in implementation order):
1. `/admin/settings/fees/page.tsx` — simplest (form only, no actions in header) — serves as proof-of-concept
2. `/admin/users/page.tsx` — remove existing `max-w-6xl` ad-hoc container
3. `/admin/page.tsx` (dashboard) — simple header + cards
4. `/admin/account/page.tsx` — simple header + card
5. `/admin/plans/page.tsx` — header + table + breadcrumb
6. `/admin/plans/new/page.tsx` — form + breadcrumb with dynamic label
7. `/admin/plans/clone/page.tsx` — form + breadcrumb with dynamic label
8. `/admin/plans/[year]/[planId]/page.tsx` — detail view + breadcrumb with dynamic labels
9. `/admin/plans/[year]/[planId]/edit/page.tsx` — edit form + breadcrumb with dynamic labels
10. `/portal/page.tsx` — portal variant header
11. `/portal/account/page.tsx` — portal variant header

**Rationale**: With ~11 pages, full migration is achievable in a single feature. Leaving some pages unmigrated would create confusion about which pattern to follow and violate SC-001.

## 8. Typography Scale Values & Naming (FR-017)

**Decision**: Six-tier semantic scale — `.text-h1` (1.875rem/600), `.text-h2` (1.5rem/600), `.text-h3` (1.25rem/600), `.text-h4` (1.125rem/600), `.text-body` (0.875rem, line-height 1.5), `.text-caption` (0.75rem, line-height 1.4), with a Thai-aware `[lang="th"]` override adding extra line-height for Thai diacritics and tone marks.

**Rationale**: Semantic class names (Round 2 Q2) encode size + weight + line-height + Thai adjustment as one reusable unit — simpler to maintain than combining `text-2xl font-semibold leading-tight` utilities on every heading. The specific rem values mirror shadcn/Tailwind common defaults adjusted for a business-app feel: h1 at 1.875rem (30px) is large enough for page-title prominence, h4 at 1.125rem (18px) is distinct from body text. Thai script typically needs ~10% more line-height than Latin to accommodate vowels-above and tone marks; the `[lang="th"]` override centralizes this adjustment.

**Alternatives considered**:
- **Tailwind native utilities** (`text-2xl font-semibold`): Rejected — doesn't encode Thai line-height, requires repeated combos.
- **Element-selector only** (style `h2`, `h3` globally): Rejected — prevents using heading element for non-heading visual (rare but useful, e.g., styled label acting as section header).

## 9. Button Height Reconciliation with Form Fields (FR-014/019, Clarifications R2 Q1)

**Decision**: Button `size="default"` changes from `h-8` (32px) to `h-9` (36px) to match Input `--input-height: 2.25rem` (36px). Button `size="sm"` stays `h-7` (28px), `size="lg"` stays `h-9` but should be reviewed.

**Rationale**: Forms routinely place Buttons adjacent to Inputs (submit, cancel, inline save). A 4px vertical mismatch looks visually unresolved and prevents clean baseline alignment. WCAG 2.5.5 (Target Size, Level AAA; also applies to AA recommendations) prefers ≥44px touch targets, and 36px is closer to that target than 32px. Impact analysis: default-size buttons across the codebase will render 4px taller, which may cause minor visual reflow in dense layouts (e.g., toolbar icon groups), but no functional breakage.

**Alternatives considered**:
- **Lower Input to 32px**: Rejected — less touch-friendly, and 36px is a more common form-control height in enterprise UIs (Material, Ant Design).
- **Accept 32/36 mismatch**: Rejected — creates the contradiction that Clarifications R2 Q1 was asked to resolve.
- **Both 40px (h-10)**: Rejected — larger than shadcn default, would add unnecessary vertical density change.

## 10. Form Field Dimensions (FR-019)

**Decision**: `--input-height: 2.25rem` (36px), `--input-padding-x: 0.75rem` (12px), `--field-label-gap: 0.375rem` (6px), `--field-error-color: var(--destructive)`, disabled state mirrors Button (`opacity: 0.5 + cursor-not-allowed + pointer-events-none`).

**Rationale**: 36px matches Button and meets touch-target guidance. 12px horizontal padding gives comfortable text breathing room. 6px label gap (between label text and field top) is tight enough to feel associated but loose enough to read separately. Error color reuses existing `--destructive` token for consistency with Button variant="destructive".

## 11. Data Table Row Height (FR-020)

**Decision**: `--table-row-height: 2.75rem` (44px), `--table-cell-padding-x: 0.75rem` (12px), `--table-cell-padding-y: 0.5rem` (8px), `--table-row-hover-bg: color-mix(in oklch, var(--muted) 50%, transparent)`, header styling uses uppercase + letter-spacing via shared table component defaults.

**Rationale**: 44px row height is the common "comfortable" density — readable without being cramped. This matches enterprise table defaults in Material (48px) and Notion (40px), averaged to 44px for Chamber-OS's medium-density use cases. Horizontal scroll on <768px viewports via `overflow-x-auto` wrapper on the `<table>` container prevents page-level horizontal scroll while preserving full table data access.

**Alternatives considered**:
- **Compact 36px row**: Rejected — too tight for action buttons inside rows (36px row + 36px button = vertical clipping risk).
- **Card-stack responsive (each row → card on mobile)**: Deferred — significant extra implementation and UX debate; horizontal scroll is the pragmatic default for MVP.

## 12. Focus Ring Shared Pattern (FR-018)

**Decision**: Reuse the existing Button `focus-visible:outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` pattern as a shared `.focus-ring` utility class; apply to Input, Textarea, Select trigger, Checkbox, RadioGroup item, Switch, Tabs trigger, DropdownMenu trigger.

**Rationale**: The Button focus ring is already proven (shipped via F1) and matches shadcn/ui defaults. Centralizing as a utility class ensures consistency and simplifies audit — any future interactive primitive just applies `.focus-ring` and inherits correctly. `focus-visible:` (not `focus:`) ensures the ring appears only for keyboard focus, not mouse clicks, which is the correct WCAG 2.4.7 behaviour.

## 13. Overlay Tokens (FR-021/022/023)

**Decision**: `--card-padding: 1.5rem`, `--card-radius: var(--radius-lg)`, `--card-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05)`; `--modal-backdrop-opacity: 0.8`, `--modal-max-width-sm: 25rem / md: 32rem / lg: 42rem`, `--modal-duration: 200ms`, `--modal-easing: cubic-bezier(0.4, 0, 0.2, 1)` (Material "standard" easing curve — natural deceleration paired with 200ms duration). All DropdownMenu triggers use `Button variant="ghost"` via the `asChild` pattern (including avatar/chevron children).

**Rationale**: Card padding at 1.5rem (24px) matches `--page-padding-x/y` for visual rhythm. Three modal max-widths cover the common cases (confirmation ~400px, form ~512px, detail ~672px). Backdrop 0.8 opacity is a common default (shadcn, Material). 200ms animation duration balances perceived responsiveness (< 300ms feels instant) with smooth motion. Using Button ghost variant for DropdownMenu triggers eliminates a class of inconsistency (every menu trigger now has the same hover, focus, and disabled behaviour automatically).

## 14. Atomic Migration vs Split (Clarifications R2 Q3)

**Decision**: Ship F4 as one atomic feature — all 92 tasks / 11 user stories in a single coordinated release.

**Rationale**: Splitting into F4a (Layout only) + F4b (Design System) would create a visible intermediate state where pages use the new layout primitives but still render ad-hoc button/typography/form styling — looking unfinished and confusing reviewers. Atomic ship guarantees that when users see the new pages, everything is consistent. The trade-off is a larger PR / review burden, mitigated by test matrix coverage (14 E2E test files) + staged implementation (Foundational → US1 MVP checkpoint → subsequent stories).

**Alternatives considered**:
- **F4a + F4b split by priority**: Rejected — creates the intermediate inconsistency above.
- **Feature flags per user story**: Rejected — adds complexity for a one-time migration that won't be rolled back.
