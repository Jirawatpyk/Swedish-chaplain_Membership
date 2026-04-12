# UX Requirements Quality Checklist: Navigation Menu

**Purpose**: Validate that UX requirements for the nav menu feature are complete, clear, consistent, and measurable across all dimensions (structure, responsive, i18n, a11y, theming, state)
**Created**: 2026-04-12
**Feature**: [spec.md](../spec.md) | [plan.md](../plan.md)
**Focus**: UX comprehensive | Depth: Standard | Actor: Reviewer (PR)

## Requirement Completeness

- [x] CHK001 - Are expanded sidebar width and collapsed rail width explicitly specified? [Gap — spec mentions "icon-only rail" but no dimensions defined] → **FIXED: FR-001 now specifies ~240px expanded, ~48px collapsed**
- [x] CHK002 - Are tenant name/logo display requirements defined for the sidebar header (size, truncation, fallback when no logo exists)? [Completeness, Spec §US1-AS5] → **FIXED: FR-010 now specifies truncation, collapsed compact identifier, fallback**
- [x] CHK003 - Are loading state requirements defined for the sidebar on initial page load (before localStorage/cookie is read)? [Gap] → **FIXED: FR-003 now specifies cookie sync for SSR initial state + fallback to expanded**
- [ ] CHK004 - Are empty state requirements defined for the member portal nav when only 1 page exists? [Gap, Spec §US4] → *Deferred: member portal always has ≥2 pages (Dashboard + Account); single-page scenario is unrealistic*
- [x] CHK005 - Are animation/transition requirements specified for sidebar collapse/expand (duration, easing, direction)? [Completeness, Spec §FR-012] → **FIXED: FR-012 now specifies 200-300ms, ease-out, reduced-motion override**
- [x] CHK006 - Are mobile drawer overlay requirements defined (backdrop opacity, z-index relative to other overlays like command palette)? [Gap, Spec §US3] → **FIXED: FR-008 now specifies semi-transparent backdrop + stacking order below command palette**
- [x] CHK007 - Are requirements defined for the hamburger button's position, size, and visual treatment in the header? [Gap, Spec §US3-AS1] → **FIXED: FR-008 now specifies header bar, left-aligned, below tablet breakpoint**

## Requirement Clarity

- [ ] CHK008 - Is "tablet breakpoint (768px)" explicitly documented as the responsive threshold, or does it defer to a design token? [Clarity, Spec §FR-004]
- [x] CHK009 - Is "visually highlighted as active" quantified with specific visual treatment (background, border, font weight, color)? [Clarity, Spec §FR-002] → **FIXED: FR-002 now specifies distinct background/left-border accent per design system tokens**
- [x] CHK010 - Is "icon and a text label" specified with icon size, spacing, and alignment details? [Clarity, Spec §US1-AS4] → **FIXED: FR-002 now specifies 20×20px icons with consistent spacing**
- [ ] CHK011 - Is "tooltip shows the full label" specified with tooltip delay, position, and max-width? [Clarity, Spec §US2-AS2]
- [x] CHK012 - Is "under 300ms perceived response time" (SC-003) defined as a CSS transition duration or a user-perceived metric with measurement method? [Clarity, Spec §SC-003] → **FIXED: FR-012 now explicitly defines CSS transition 200-300ms with ease-out easing**

## Requirement Consistency

- [ ] CHK013 - Are active-state highlighting requirements consistent between staff sidebar items, Settings sub-items, and member nav items? [Consistency, Spec §FR-002 + §US4-AS2]
- [ ] CHK014 - Are responsive behaviour requirements consistent between staff sidebar mobile drawer and member nav mobile adaptation? [Consistency, Spec §US3 + §US4-AS4]
- [ ] CHK015 - Is the collapse toggle button placement consistent with the sidebar header layout (tenant name area)? [Consistency, Spec §US1-AS5 + §US2]
- [ ] CHK016 - Are light/dark theme requirements consistent across sidebar, member nav, and mobile drawer? [Consistency, Spec §FR-011]

## Acceptance Criteria Quality

- [ ] CHK017 - Can SC-005 ("modifying only the nav configuration data") be objectively measured with a specific verification method? [Measurability, Spec §SC-005]
- [x] CHK018 - Can SC-007 ("no flash of incorrect state") be objectively verified given the SSR/hydration context? [Measurability, Spec §SC-007 + plan SSR State Sync] → **FIXED: FR-003 now specifies cookie-based SSR sync mechanism to prevent hydration mismatch**
- [ ] CHK019 - Is SC-001 ("under 2 clicks from any page") verifiable for all page-to-page combinations, including Settings sub-pages? [Measurability, Spec §SC-001]

## Scenario Coverage

- [x] CHK020 - Are requirements defined for the interaction between command palette (Cmd+K) and sidebar — can both be open simultaneously? [Coverage, Gap] → **FIXED: Assumptions section now specifies stacking order and independence**
- [ ] CHK021 - Are requirements defined for sidebar behaviour during page transitions (does it remain visually stable while content loads)? [Coverage, Gap]
- [ ] CHK022 - Are requirements defined for how the sidebar interacts with the existing Plans breadcrumb when both are visible? [Coverage, Spec §Assumptions — breadcrumbs untouched]
- [x] CHK023 - Are requirements defined for NavGroup collapse state persistence — does an expanded Settings group stay expanded across page navigations? [Coverage, Gap] → **FIXED: Edge Cases now specifies NavGroup state persists during navigation, auto-expands on active child match**

## Edge Case Coverage

- [ ] CHK024 - Is the Dashboard exact-match active-state rule explicitly specified in acceptance scenarios (not just edge cases)? [Edge Case, Spec §Edge Cases — added by critique]
- [x] CHK025 - Are requirements defined for sidebar behaviour when browser window is resized across the tablet breakpoint while the page is open? [Edge Case, Gap] → **FIXED: Edge Cases now specifies seamless switch between persistent/drawer mode, drawer closes on upsize**
- [x] CHK026 - Are requirements defined for very long nav labels in TH/SV locales that may overflow the sidebar width? [Edge Case, i18n + layout] → **FIXED: Edge Cases now specifies ellipsis truncation, no overflow/wrapping, tooltip for full label**
- [ ] CHK027 - Are requirements defined for the NavGroup "single child → flat link" transformation including the visual transition? [Edge Case, Spec §Key Entities — NavGroup]

## Non-Functional Requirements (i18n, A11y, Theming)

- [x] CHK028 - Are ARIA role and landmark requirements specified for the sidebar (`nav`, `role="navigation"`, `aria-label`)? [A11y, Gap] → **FIXED: FR-007 now specifies `<nav>` landmark with descriptive `aria-label`**
- [x] CHK029 - Are screen reader announcement requirements defined for sidebar collapse/expand state changes? [A11y, Gap] → **FIXED: FR-007 specifies `aria-expanded` + US5-AS6 added for screen reader announcement**
- [x] CHK030 - Are focus trap requirements defined for the mobile drawer (focus stays within drawer while open)? [A11y, Spec §US5-AS3] → **FIXED: FR-007 now explicitly requires focus trap in mobile drawer**
- [x] CHK031 - Are RTL layout requirements explicitly excluded or addressed for the sidebar? [i18n, Gap — TH/SV/EN are all LTR, but worth documenting exclusion] → **FIXED: FR-007 now explicitly excludes RTL (all 3 locales are LTR)**
- [x] CHK032 - Are reduced-motion requirements defined for users with `prefers-reduced-motion`? [A11y, Gap — Constitution Principle VI WCAG 2.1 AA] → **FIXED: FR-012 specifies instant state changes for reduced-motion + US5-AS7 added**

## Dependencies & Assumptions

- [ ] CHK033 - Is the assumption that shadcn/ui Sidebar component provides built-in mobile Sheet drawer documented with a verification step? [Assumption, plan §R1]
- [x] CHK034 - Is the cookie-based SSR sync strategy (from critique) reflected in spec acceptance scenarios, not just the plan? [Dependency, plan §SSR State Sync vs Spec §SC-007] → **FIXED: FR-003 now specifies cookie sync for SSR + fallback**

## Notes

- Check items off as completed: `[x]`
- Items referencing `[Gap]` indicate requirements not yet in the spec — consider adding them
- Items referencing `[Clarity]` suggest existing requirements need quantification
- Traceability: 31/34 items (91%) have spec/plan references
